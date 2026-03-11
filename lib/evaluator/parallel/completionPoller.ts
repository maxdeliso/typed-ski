/**
 * Completion queue polling for parallel arena evaluator.
 *
 * Polls the completion queue, handles results and suspensions, and manages
 * resubmissions with time-slicing to prevent main thread saturation.
 *
 * @module
 */

import { ArenaKind } from "../../shared/arena.ts";
import { sleep } from "../async.ts";
import type { ArenaWasmExports } from "../arenaEvaluator.ts";
import type { IoManager } from "../io/ioManager.ts";
import type { RingStats } from "../io/ringStats.ts";
import type { RequestTracker } from "./requestTracker.ts";

const EMPTY = -1n;
const SUSPEND_MODE_IO_WAIT = 2;
const DEFAULT_MAX_STEPS = 0xffffffff;

// CQ Event Kinds (synchronized with c/arena.c)
const CQ_EVENT_YIELD = 1;
const CQ_EVENT_IO_WAIT = 2;
const CQ_EVENT_ERROR = 3;

function stepBudgetExhaustedError(reqId: number): Error {
  return new Error(
    `Request ${reqId} exhausted max steps before reaching normal form.`,
  );
}

/**
 * Time budget (in milliseconds) for processing completion queue events before yielding.
 */
const SLICE_BUDGET_MS = 8;

/**
 * Maximum number of completion queue events to process in a single time slice.
 */
const MAX_EVENTS_PER_SLICE = 4096;

/**
 * Threshold for busy-waiting in resubmitSuspension before yielding.
 */
const RESUBMIT_BUSY_WAIT_THRESHOLD = 64;

/**
 * Sleep duration (in milliseconds) when resubmit busy-wait threshold is exceeded.
 */
const RESUBMIT_SLEEP_MS = 1;

/**
 * Threshold for busy-waiting in submitSuspension before yielding.
 */
const SUBMIT_BUSY_WAIT_THRESHOLD = 512;

/**
 * Polls the completion queue and handles results/suspensions.
 */
export class CompletionPoller {
  private pollerStarted = false;
  private readonly activeTimeouts = new Set<() => void>();
  private readonly requestTracker: RequestTracker;
  private readonly ioManager: IoManager;
  private readonly ringStats: RingStats;
  private readonly exports: ArenaWasmExports;
  private readonly aborted: () => boolean;

  constructor(
    requestTracker: RequestTracker,
    ioManager: IoManager,
    ringStats: RingStats,
    exports: ArenaWasmExports,
    aborted: () => boolean,
  ) {
    this.requestTracker = requestTracker;
    this.ioManager = ioManager;
    this.ringStats = ringStats;
    this.exports = exports;
    this.aborted = aborted;
  }

  /**
   * Starts the polling loop.
   */
  start(hostPullV2: () => bigint): void {
    if (this.pollerStarted) return;
    this.pollerStarted = true;

    const pull = hostPullV2;
    (async () => {
      let emptyStreak = 0;
      const nowMs = () =>
        (typeof performance !== "undefined" &&
            typeof performance.now === "function")
          ? performance.now()
          : Date.now();

      const yieldToRenderer = async (ms = 0) => {
        if (this.aborted()) return;
        const { promise, cancel } = sleep(ms);
        this.activeTimeouts.add(cancel);
        try {
          await promise;
        } finally {
          this.activeTimeouts.delete(cancel);
        }
      };

      let sliceStart = nowMs();
      let sliceEvents = 0;

      const maybeYield = async () => {
        if (
          sliceEvents < MAX_EVENTS_PER_SLICE &&
          nowMs() - sliceStart < SLICE_BUDGET_MS
        ) {
          // Always yield to microtask to prevent starving other promises/IO
          await new Promise<void>((r) => queueMicrotask(r));
          return;
        }
        sliceEvents = 0;
        sliceStart = nowMs();
        await yieldToRenderer(0);
        sliceStart = nowMs();
      };

      const ex = this.exports as unknown as {
        kindOf: (id: number) => number;
        symOf: (id: number) => number;
        hashOf?: (id: number) => number;
        leftOf: (id: number) => number;
        rightOf: (id: number) => number;
        hostSubmit: (nodeId: number, reqId: number, maxSteps: number) => number;
      };

      for (;;) {
        if (this.aborted()) return;

        // Hibernate briefly if no work is pending.
        if (this.requestTracker.getTotalPending() === 0) {
          await yieldToRenderer(10);
          sliceEvents = 0;
          sliceStart = nowMs();
          continue;
        }

        const packed = pull();
        if (packed === EMPTY) {
          this.ringStats.recordPullEmpty();
          emptyStreak++;
          if (emptyStreak < 10) {
            await new Promise<void>((r) => queueMicrotask(r));
          } else {
            await yieldToRenderer(1);
          }
          sliceEvents = 0;
          sliceStart = nowMs();
          continue;
        }

        this.ringStats.recordPullNonEmpty();
        emptyStreak = 0;

        const reqId = Number((packed >> 32n) & 0xffffffffn) >>> 0;
        const low = Number(packed & 0xffffffffn) >>> 0;
        const eventKind = low >>> 30;
        const nodeId = low & 0x3fffffff;

        if (eventKind === CQ_EVENT_ERROR) {
          this.requestTracker.markError(
            reqId,
            new Error(`Worker reported error event for reqId ${reqId}`),
          );
          sliceEvents++;
          await maybeYield();
          continue;
        }

        // Check if this is a yield/suspension
        const isTypedYield = eventKind === CQ_EVENT_YIELD ||
          eventKind === CQ_EVENT_IO_WAIT;
        const shouldInspectNode = eventKind !== CQ_EVENT_IO_WAIT &&
          nodeId < 0x3fffffff;
        const nodeKind = shouldInspectNode ? ex.kindOf(nodeId) : 0;

        const isControlNode = nodeKind === (ArenaKind.Suspension as number) ||
          nodeKind === (ArenaKind.Continuation as number);

        if (isTypedYield || isControlNode) {
          if (!this.requestTracker.isPending(reqId)) {
            // Already completed or aborted
            sliceEvents++;
            await maybeYield();
            continue;
          }

          const suspensionMode = nodeKind === (ArenaKind.Suspension as number)
            ? ex.symOf(nodeId)
            : -1;
          const isIoWait = eventKind === CQ_EVENT_IO_WAIT ||
            suspensionMode === SUSPEND_MODE_IO_WAIT;

          if (isIoWait) {
            this.ioManager.registerIoWait(nodeId, reqId);
            const handled = await this.handleIoWaitSuspension(nodeId, reqId);
            if (!handled) {
              // Handled later via wakeStdinWaiters (e.g. stdin available)
            }
            sliceEvents++;
            await maybeYield();
            continue;
          }

          const isStepBudgetExhausted = eventKind === CQ_EVENT_YIELD &&
            nodeKind === (ArenaKind.Suspension as number) &&
            suspensionMode !== SUSPEND_MODE_IO_WAIT &&
            ex.hashOf?.(nodeId) === 0;

          if (isStepBudgetExhausted) {
            this.requestTracker.markError(
              reqId,
              stepBudgetExhaustedError(reqId),
            );
            sliceEvents++;
            await maybeYield();
            continue;
          }

          // Regular yield: resubmit
          try {
            const resubmitCount = this.requestTracker.incrementResubmit(reqId);
            this.requestTracker.recordYield(reqId, nodeId, resubmitCount);
            await this.resubmitSuspension(nodeId, reqId);
          } catch (error) {
            if (error instanceof Error) {
              this.requestTracker.markError(reqId, error);
            }
            sliceEvents++;
            await maybeYield();
            continue;
          }
          sliceEvents++;
          await maybeYield();
          continue;
        }

        // Final result (CQ_EVENT_DONE)
        const wasPending = this.requestTracker.isPending(reqId);

        // Check for control nodes in results - theoretically shouldn't happen with
        // CQ_EVENT_DONE but good for robustness.
        if (
          wasPending &&
          this.requestTracker.getResubmitCount(reqId) > 0 &&
          this.containsInternalControlNode(nodeId, ex)
        ) {
          try {
            const resubmitCount = this.requestTracker.incrementResubmit(reqId);
            this.requestTracker.recordYield(reqId, nodeId, resubmitCount);
            await this.submitNode(nodeId, reqId, DEFAULT_MAX_STEPS);
          } catch (error) {
            if (error instanceof Error) {
              this.requestTracker.markError(reqId, error);
            }
          }
          sliceEvents++;
          await maybeYield();
          continue;
        }

        this.requestTracker.markCompleted(reqId, nodeId);
        if (!wasPending) {
          this.ringStats.recordCompletionStashed();
        }

        sliceEvents++;
        await maybeYield();
      }
    })();
  }

  /**
   * Stops the polling loop and cleans up resources.
   */
  stop(): void {
    this.pollerStarted = false;
    for (const cancel of this.activeTimeouts) {
      cancel();
    }
    this.activeTimeouts.clear();
  }

  private async handleIoWaitSuspension(
    nodeId: number,
    reqId: number,
  ): Promise<boolean> {
    const handled = await this.ioManager.handleIoWaitSuspension(
      nodeId,
      reqId,
      async (nId, rId) => {
        await this.submitSuspension(nId, rId);
      },
    );
    return handled;
  }

  private async resubmitSuspension(
    nodeId: number,
    reqId: number,
  ): Promise<void> {
    const ex = this.exports as unknown as {
      hostSubmit: (nodeId: number, reqId: number, maxSteps: number) => number;
    };
    // Suspension resubmissions pass 0 maxSteps to indicate "continue from suspension"
    let rc = ex.hostSubmit(nodeId >>> 0, reqId, 0);
    let fullStreak = 0;
    while (rc === 1) {
      this.ringStats.recordSubmitFull();
      if (this.aborted()) return;
      fullStreak++;
      if (fullStreak < RESUBMIT_BUSY_WAIT_THRESHOLD) {
        await new Promise<void>((r) => queueMicrotask(r));
      } else {
        if (this.aborted()) return;
        const { promise, cancel } = sleep(RESUBMIT_SLEEP_MS);
        this.activeTimeouts.add(cancel);
        try {
          await promise;
        } finally {
          this.activeTimeouts.delete(cancel);
        }
        if (this.aborted()) return;
      }
      rc = ex.hostSubmit(nodeId >>> 0, reqId, 0);
    }
    if (rc !== 0) {
      throw new Error(`Resubmit failed for reqId ${reqId} with code ${rc}`);
    }
  }

  private async submitSuspension(
    nodeId: number,
    reqId: number,
  ): Promise<void> {
    const ex = this.exports as unknown as {
      hostSubmit: (nodeId: number, reqId: number, maxSteps: number) => number;
    };
    let rc = ex.hostSubmit(nodeId >>> 0, reqId, 0);
    let fullStreak = 0;
    while (rc === 1) {
      this.ringStats.recordSubmitFull();
      if (this.aborted()) return;
      fullStreak++;
      if (fullStreak < SUBMIT_BUSY_WAIT_THRESHOLD) {
        await new Promise<void>((r) => queueMicrotask(r));
      } else {
        if (this.aborted()) return;
        const { promise, cancel } = sleep(0);
        this.activeTimeouts.add(cancel);
        try {
          await promise;
        } finally {
          this.activeTimeouts.delete(cancel);
        }
        if (this.aborted()) return;
      }
      rc = ex.hostSubmit(nodeId >>> 0, reqId, 0);
    }
    if (rc !== 0) {
      throw new Error(`Resubmit failed for reqId ${reqId} with code ${rc}`);
    }
  }

  private async submitNode(
    nodeId: number,
    reqId: number,
    maxSteps: number,
  ): Promise<void> {
    const ex = this.exports as unknown as {
      hostSubmit: (nodeId: number, reqId: number, maxSteps: number) => number;
    };
    let rc = ex.hostSubmit(nodeId >>> 0, reqId, maxSteps >>> 0);
    let fullStreak = 0;
    while (rc === 1) {
      this.ringStats.recordSubmitFull();
      if (this.aborted()) return;
      fullStreak++;
      if (fullStreak < SUBMIT_BUSY_WAIT_THRESHOLD) {
        await new Promise<void>((r) => queueMicrotask(r));
      } else {
        if (this.aborted()) return;
        const { promise, cancel } = sleep(0);
        this.activeTimeouts.add(cancel);
        try {
          await promise;
        } finally {
          this.activeTimeouts.delete(cancel);
        }
        if (this.aborted()) return;
      }
      rc = ex.hostSubmit(nodeId >>> 0, reqId, maxSteps >>> 0);
    }
    if (rc !== 0) {
      throw new Error(`Submit failed for reqId ${reqId} with code ${rc}`);
    }
  }

  private containsInternalControlNode(
    rootNodeId: number,
    ex: {
      kindOf: (id: number) => number;
      leftOf: (id: number) => number;
      rightOf: (id: number) => number;
    },
  ): boolean {
    const stack = [rootNodeId >>> 0];
    const seen = new Set<number>();
    while (stack.length > 0) {
      const nodeId = stack.pop()!;
      if (seen.has(nodeId)) continue;
      seen.add(nodeId);
      const kind = ex.kindOf(nodeId);
      if (
        kind === (ArenaKind.Continuation as number) ||
        kind === (ArenaKind.Suspension as number)
      ) {
        return true;
      }
      if (kind === (ArenaKind.NonTerm as number)) {
        stack.push(ex.leftOf(nodeId) >>> 0);
        stack.push(ex.rightOf(nodeId) >>> 0);
      }
    }
    return false;
  }
}
