/**
 * Completion queue polling for parallel arena evaluator.
 *
 * Polls the completion queue, handles results and suspensions, and manages
 * resubmissions with time-slicing to prevent main thread saturation.
 *
 * @module
 */

import { ArenaKind } from "../../shared/arena.ts";
import type { ArenaWasmExports } from "../arenaEvaluator.ts";
import type { IoManager } from "../io/ioManager.ts";
import type { RingStats } from "../io/ringStats.ts";
import type { RequestTracker } from "./requestTracker.ts";

const EMPTY = -1n;
const SUSPEND_MODE_IO_WAIT = 2;

/**
 * Time budget (in milliseconds) for processing completion queue events before yielding.
 *
 * Default: 8ms
 * Rationale: Matches typical browser frame budgets (~16ms) divided by 2, ensuring we
 * yield frequently enough to maintain UI responsiveness while processing events efficiently.
 * This prevents main thread saturation and allows rendering to occur.
 */
const SLICE_BUDGET_MS = 8;

/**
 * Maximum number of completion queue events to process in a single time slice.
 *
 * Default: 4096 events
 * Rationale: Provides a reasonable upper bound on synchronous work per slice. Large enough
 * to process bursts efficiently, but small enough to prevent long-running synchronous
 * operations that could block rendering or other tasks.
 */
const MAX_EVENTS_PER_SLICE = 4096;

/**
 * Number of sleep iterations when no work is pending (hibernation mode).
 *
 * Default: 50 iterations
 * Rationale: When there's no pending work, we sleep in small chunks (1ms each) to check
 * for abort signals frequently while still conserving CPU. 50 iterations gives ~50ms total
 * sleep time, which is short enough to respond quickly to new work while long enough to
 * save significant CPU cycles during idle periods.
 */
const HIBERNATION_ITERATIONS = 50;

/**
 * Sleep duration (in milliseconds) when no work is pending.
 *
 * Default: 1ms
 * Rationale: Very short sleep that allows frequent abort checks while still yielding CPU
 * time. Short enough to respond quickly to new work, but long enough to avoid busy-waiting.
 */
const HIBERNATION_SLEEP_MS = 1;

/**
 * Threshold for empty completion queue retries before yielding to event loop.
 *
 * Default: 512 iterations
 * Rationale: When the completion queue is empty, we initially use queueMicrotask() for
 * rapid retries (low latency). After 512 consecutive empty pulls, we switch to sleep(0)
 * to yield to the event loop, preventing starvation of other tasks. 512 balances:
 * - High enough to avoid unnecessary context switches for transient emptiness
 * - Low enough to prevent blocking the event loop and maintain responsiveness
 */
const EMPTY_STREAK_THRESHOLD = 512;

/**
 * Threshold for busy-waiting in resubmitSuspension before yielding.
 *
 * Default: 64 iterations
 * Rationale: When resubmitting a suspension and the submission queue is full, we use
 * queueMicrotask() for rapid retries. After 64 failures, we switch to sleep(1ms) to yield.
 * Lower than other thresholds (64 vs 512) because resubmissions are more critical and
 * should yield sooner to avoid blocking other work units.
 */
const RESUBMIT_BUSY_WAIT_THRESHOLD = 64;

/**
 * Sleep duration (in milliseconds) when resubmit busy-wait threshold is exceeded.
 *
 * Default: 1ms
 * Rationale: Short sleep that yields CPU while allowing quick retry of resubmissions.
 * Longer than sleep(0) to ensure we actually yield, since resubmissions are critical.
 */
const RESUBMIT_SLEEP_MS = 1;

/**
 * Threshold for busy-waiting in submitSuspension before yielding.
 *
 * Default: 512 iterations
 * Rationale: When submitting a suspension and the submission queue is full, we use
 * queueMicrotask() for rapid retries. After 512 failures, we switch to sleep(0) to yield
 * to the event loop. Same threshold as empty streak for consistency in yielding behavior.
 */
const SUBMIT_BUSY_WAIT_THRESHOLD = 512;

/**
 * Cancellable sleep function that returns both the promise and a cleanup function.
 */
function sleep(ms: number): { promise: Promise<void>; cancel: () => void } {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const promise = new Promise<void>((r) => {
    timeoutId = setTimeout(r, ms);
  });
  const cancel = () => {
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
  };
  return { promise, cancel };
}

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
  start(hostPull: () => bigint): void {
    if (this.pollerStarted) return;
    this.pollerStarted = true;
    const pull = hostPull;
    (async () => {
      let emptyStreak = 0;
      // Prevent main-thread saturation under load by time-slicing CQ drains.
      // Microtask yielding is not sufficient to guarantee rendering; prefer rAF when available.
      const nowMs = () =>
        (typeof performance !== "undefined" &&
            typeof performance.now === "function")
          ? performance.now()
          : Date.now();
      const yieldToRenderer = async () => {
        // Browser: yield to the next frame so painting can happen.
        if (typeof requestAnimationFrame === "function") {
          await new Promise<void>((r) => requestAnimationFrame(() => r()));
          return;
        }
        // Non-browser (tests/deno): yield back to the macrotask queue.
        if (this.aborted()) return;
        const { promise, cancel } = sleep(0);
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
        // Avoid doing an unbounded amount of synchronous work without yielding.
        if (
          sliceEvents < MAX_EVENTS_PER_SLICE &&
          nowMs() - sliceStart < SLICE_BUDGET_MS
        ) {
          return;
        }
        sliceEvents = 0;
        sliceStart = nowMs();
        await yieldToRenderer();
        sliceStart = nowMs();
      };
      const ex = this.exports as unknown as {
        kindOf: (id: number) => number;
        symOf: (id: number) => number;
        hostSubmit: (nodeId: number, reqId: number, maxSteps: number) => number;
      };
      for (;;) {
        if (this.aborted()) return;

        // OPTIMIZATION: If no work is pending, hibernate.
        // This prevents burning CPU when the user is staring at the screen doing nothing.
        // Use very short sleeps (1ms) in a loop to check aborted frequently while still saving CPU.
        if (this.requestTracker.getTotalPending() === 0) {
          // Check aborted before sleeping to avoid creating a timer that leaks
          if (this.aborted()) return;
          // Sleep in small chunks, checking aborted frequently
          for (let i = 0; i < HIBERNATION_ITERATIONS; i++) {
            if (this.aborted()) return;
            const { promise, cancel } = sleep(HIBERNATION_SLEEP_MS);
            this.activeTimeouts.add(cancel);
            try {
              await promise;
            } finally {
              this.activeTimeouts.delete(cancel);
            }
            if (this.aborted()) return;
          }
          sliceEvents = 0;
          sliceStart = nowMs();
          continue;
        }

        const packed = pull();
        if (packed === EMPTY) {
          this.ringStats.recordPullEmpty();
          // If the CQ is empty, avoid burning CPU by spinning in the microtask queue.
          // Use a short macrotask backoff once we've observed emptiness for a while.
          emptyStreak++;
          if (emptyStreak < EMPTY_STREAK_THRESHOLD) {
            await new Promise<void>((r) => queueMicrotask(r));
          } else {
            if (this.aborted()) return;
            const { promise, cancel } = sleep(0); // Try 0 first, it might yield but return faster than 1
            this.activeTimeouts.add(cancel);
            try {
              await promise;
            } finally {
              this.activeTimeouts.delete(cancel);
            }
            if (this.aborted()) return;
          }
          sliceEvents = 0;
          sliceStart = nowMs();
          continue;
        }
        this.ringStats.recordPullNonEmpty();
        emptyStreak = 0;
        const reqId = Number((packed >> 32n) & 0xffffffffn) >>> 0;
        const nodeId = Number(packed & 0xffffffffn) >>> 0;

        // If the worker yielded, the nodeId is a Suspension or Continuation node. Resubmit to continue.
        // (Do not resolve the promise yet; the job is still in-flight.)
        const nodeKind = ex.kindOf(nodeId);
        if (
          nodeKind === (ArenaKind.Suspension as number) ||
          nodeKind === (ArenaKind.Continuation as number)
        ) {
          // If the caller already gave up / was aborted, drop the yielded work.
          if (!this.requestTracker.isPending(reqId)) continue;

          if (ex.symOf(nodeId) === SUSPEND_MODE_IO_WAIT) {
            this.ioManager.registerIoWait(nodeId, reqId);
            const handled = await this.handleIoWaitSuspension(nodeId, reqId);
            if (!handled) {
              // Will be handled later when stdin data arrives via ioManager.wakeStdinWaiters
            }
            sliceEvents++;
            await maybeYield();
            continue;
          }

          // Track resubmissions per work unit to prevent infinite loops from divergent terms.
          // Check BEFORE attempting to resubmit - if limit exceeded, stop this work unit.
          try {
            const resubmitCount = this.requestTracker.incrementResubmit(reqId);
            this.requestTracker.recordYield(reqId, nodeId, resubmitCount);

            // Retry submitting until queue accepts (unbounded retries when queue is full).
            // The per-work-unit resubmission limit above prevents individual work units
            // from monopolizing resources.
            // when resubmitting a suspension, max_steps is ignored by the worker
            // (it uses the suspension's internal hash field for remaining budget), so we pass 0.
            // The worker will read the count from the Suspension node's hash field.
            await this.resubmitSuspension(nodeId, reqId);
          } catch (error) {
            // Resubmission limit exceeded or other error
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

        // Regular completion
        const wasPending = this.requestTracker.isPending(reqId);
        this.requestTracker.markCompleted(reqId, nodeId);
        if (!wasPending) {
          // Completion was stashed (no pending resolver)
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
    for (const cancel of this.activeTimeouts) {
      cancel();
    }
    this.activeTimeouts.clear();
  }

  private async handleIoWaitSuspension(
    nodeId: number,
    reqId: number,
  ): Promise<boolean> {
    // Try to handle immediately if there's wake budget
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
      // retry passes 0 max steps for suspensions
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
}
