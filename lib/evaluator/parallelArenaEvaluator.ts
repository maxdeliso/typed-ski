/**
 * Parallel arena evaluator using Web Workers.
 *
 * This module orchestrates the creation of the Shared Memory environment,
 * spawns the worker pool, and manages the main thread's interaction with the
 * shared Rust arena.
 *
 * @module
 */

import type { SKIExpression } from "../ski/expression.ts";
import type { Evaluator } from "./evaluator.ts";
import { ArenaEvaluatorWasm, type ArenaWasmExports } from "./arenaEvaluator.ts";
import { getEmbeddedReleaseWasm } from "./arenaWasm.embedded.ts";
import { ArenaKind } from "../shared/arena.ts";

const EMPTY = -1n;
// Cancellable sleep function that returns both the promise and a cleanup function
const sleep = (ms: number): { promise: Promise<void>; cancel: () => void } => {
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
};
// Maximum number of resubmissions per work unit (when yielding suspensions)
// This prevents a single divergent term from monopolizing resources
const MAX_RESUBMITS_PER_WORK_UNIT = 10;

/**
 * Error thrown when a work unit exceeds the maximum number of resubmissions.
 * This typically indicates that the expression does not normalize (diverges).
 */
export class ResubmissionLimitExceededError extends Error {
  constructor(
    public readonly reqId: number,
    public readonly resubmitCount: number,
    public readonly maxResubmits: number,
  ) {
    super(
      `Request ${reqId} exceeded maximum resubmissions (${maxResubmits}). This expression likely does not normalize.`,
    );
    this.name = "ResubmissionLimitExceededError";
  }
}

export type ArenaRingStatsSnapshot = {
  submitOk: number;
  submitFull: number;
  submitNotConnected: number;
  pullEmpty: number;
  pullNonEmpty: number;
  completionsStashed: number;
  pending: number;
  completed: number;
};

type WorkerConnectCompleteMessage = {
  type: "connectArenaComplete";
  error?: string;
};

type WorkerReadyMessage = {
  type: "ready";
};

type WorkerResultMessage = {
  type: "result";
  id: number;
  arenaNodeId: number; // Arena node ID for the result expression
};

type WorkerErrorMessage = {
  type: "error";
  id?: number;
  workId?: number;
  error?: string;
};

type WorkerToMainMessage =
  | WorkerReadyMessage
  | WorkerConnectCompleteMessage
  | WorkerResultMessage
  | WorkerErrorMessage;

export class ParallelArenaEvaluatorWasm extends ArenaEvaluatorWasm
  implements Evaluator {
  public readonly workers: Worker[] = [];

  /**
   * Optional instrumentation hooks (used by `server/workbench.js`).
   *
   * Notes:
   * - `workerIndex` is a logical assignment (round-robin at submit time).
   *   CQ completions don't encode the physical worker thread id.
   */
  public onRequestQueued?: (
    reqId: number,
    workerIndex: number,
    expr?: SKIExpression,
  ) => void;
  public onRequestCompleted?: (
    reqId: number,
    workerIndex: number,
    expr: SKIExpression | undefined,
    arenaNodeId: number,
  ) => void;
  public onRequestError?: (
    reqId: number,
    workerIndex: number,
    expr: SKIExpression | undefined,
    error: string,
  ) => void;
  public onRequestYield?: (
    reqId: number,
    workerIndex: number,
    expr: SKIExpression | undefined,
    suspensionNodeId: number,
    resubmitCount: number,
  ) => void;

  private nextRequestId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (val: number) => void; reject: (err: Error) => void }
  >();
  private readonly completed = new Map<number, number>();
  private pollerStarted = false;
  private aborted = false;
  private abortError: Error | null = null;
  private nextWorkerIndex = 0;
  private readonly reqToWorkerIndex = new Map<number, number>();
  private readonly reqToExpr = new Map<number, SKIExpression>();
  private readonly reqToResubmitCount = new Map<number, number>();
  private workerPendingCounts: number[] = [];
  private readonly ringStats = {
    submitOk: 0,
    submitFull: 0,
    submitNotConnected: 0,
    pullEmpty: 0,
    pullNonEmpty: 0,
    completionsStashed: 0,
  };
  private readonly activeTimeouts = new Set<() => void>();

  private abortAll(err: Error) {
    if (this.aborted) return;
    this.aborted = true;
    this.abortError = err;
    // Clear all active timeouts to prevent leaks
    for (const cancel of this.activeTimeouts) {
      cancel();
    }
    this.activeTimeouts.clear();
    for (const { reject } of this.pending.values()) reject(err);
    this.pending.clear();
    this.completed.clear();
    this.reqToWorkerIndex.clear();
    this.reqToExpr.clear();
    this.reqToResubmitCount.clear();
    this.workerPendingCounts.fill(0);
    this.workers.forEach((w) => w.terminate());
  }

  /**
   * Workbench UI helper.
   * Returns per-worker pending counts (best-effort logical assignment).
   */
  getPendingCounts(): number[] {
    const n = Math.max(1, this.workers.length);
    if (this.workerPendingCounts.length !== n) {
      this.workerPendingCounts = new Array(n).fill(0);
    }
    return this.workerPendingCounts.slice();
  }

  /**
   * Returns the total number of pending requests.
   * This is the authoritative count based on the pending Map.
   */
  getTotalPending(): number {
    return this.pending.size;
  }

  getRingStatsSnapshot(): ArenaRingStatsSnapshot {
    return {
      submitOk: this.ringStats.submitOk,
      submitFull: this.ringStats.submitFull,
      submitNotConnected: this.ringStats.submitNotConnected,
      pullEmpty: this.ringStats.pullEmpty,
      pullNonEmpty: this.ringStats.pullNonEmpty,
      completionsStashed: this.ringStats.completionsStashed,
      pending: this.pending.size,
      completed: this.completed.size,
    };
  }

  /**
   * Submit an already-allocated arena node id to the worker pool and await the resulting arena node id.
   *
   * Notes:
   * - The number of reduction steps is controlled globally by `setMaxSteps(...)`.
   * - This is the primitive used by higher-level helpers (e.g. reduceAsync) and tooling (e.g. genForest).
   */
  async reduceArenaNodeIdAsync(
    arenaNodeId: number,
    expr?: SKIExpression,
  ): Promise<number> {
    if (this.aborted) {
      throw this.abortError ?? new Error("Evaluator terminated");
    }
    const ex = this.$ as unknown as {
      hostSubmit?: (nodeId: number, reqId: number) => number;
      hostPull?: () => bigint;
    };
    if (!ex.hostPull || !ex.hostSubmit) {
      throw new Error("hostSubmit/hostPull exports are required");
    }

    const reqId = this.nextRequestId++ >>> 0;

    // Track logical worker slot for UI (round-robin assignment).
    const nWorkers = Math.max(1, this.workers.length);
    if (this.workerPendingCounts.length !== nWorkers) {
      this.workerPendingCounts = new Array(nWorkers).fill(0);
    }
    const workerIndex = this.nextWorkerIndex++ % nWorkers;
    this.reqToWorkerIndex.set(reqId, workerIndex);
    if (expr) this.reqToExpr.set(reqId, expr);
    this.workerPendingCounts[workerIndex] =
      (this.workerPendingCounts[workerIndex] ?? 0) + 1;

    this.ensurePoller(ex.hostPull);

    // Register the resolver BEFORE submitting so we can't lose a fast completion.
    const existing = this.completed.get(reqId);
    if (existing !== undefined) {
      this.completed.delete(reqId);
      return existing;
    }
    const resultPromise = new Promise<number>((resolve, reject) => {
      this.pending.set(reqId, { resolve, reject });
    });

    this.onRequestQueued?.(reqId, workerIndex, expr);

    // Non-blocking submit: retry until queued, with a fixed cap on retries.
    // 0 = ok, 1 = full, 2 = not connected
    let rc = ex.hostSubmit(arenaNodeId >>> 0, reqId);
    let fullStreak = 0;
    while (rc === 1) {
      this.ringStats.submitFull++;
      if (this.aborted) {
        throw (this.abortError ?? new Error("Evaluator terminated"));
      }
      // Avoid a tight microtask spin if workers are blocked (e.g. CQ full / no progress).
      // Back off to a macrotask so we don't peg a CPU core.
      fullStreak++;
      if (fullStreak < 512) {
        await new Promise<void>((r) => queueMicrotask(r));
      } else {
        if (this.aborted) {
          throw (this.abortError ?? new Error("Evaluator terminated"));
        }
        const { promise, cancel } = sleep(0); // Try 0 first, it might yield but return faster than 1
        this.activeTimeouts.add(cancel);
        try {
          await promise;
        } finally {
          this.activeTimeouts.delete(cancel);
        }
        if (this.aborted) {
          throw (this.abortError ?? new Error("Evaluator terminated"));
        }
      }
      rc = ex.hostSubmit(arenaNodeId >>> 0, reqId);
    }
    if (rc !== 0) {
      if (rc === 2) this.ringStats.submitNotConnected++;
      const err = new Error(`hostSubmit failed with code ${rc}`);
      this.onRequestError?.(reqId, workerIndex, expr, err.message);
      this.pending.get(reqId)?.reject(err);
      this.pending.delete(reqId);
      this.reqToWorkerIndex.delete(reqId);
      this.reqToExpr.delete(reqId);
      this.workerPendingCounts[workerIndex] = Math.max(
        0,
        (this.workerPendingCounts[workerIndex] ?? 0) - 1,
      );
      throw new Error(`hostSubmit failed with code ${rc}`);
    }
    this.ringStats.submitOk++;

    return await resultPromise;
  }

  private constructor(
    exports: ArenaWasmExports,
    memory: WebAssembly.Memory,
    workers: Worker[],
  ) {
    super(exports, memory);
    this.workers = workers;
    // If any worker traps due to OOM, abort all outstanding requests so callers don't hang forever.
    for (const w of this.workers) {
      w.addEventListener("error", (e) => {
        const err = e.error instanceof Error
          ? e.error
          : new Error(e.message || "Worker error");
        // Only abort all if this is an OOM/memory error
        const isOOM = err.message?.includes("out of memory") ||
          err.message?.includes("memory") ||
          err.message?.includes("unreachable") ||
          err.name === "RuntimeError";
        if (isOOM) {
          this.abortAll(err);
        } else {
          // For non-OOM errors, just log and continue
          console.error("Worker error (non-fatal):", err);
        }
      });
      // Some environments surface failed structured-clone / message errors separately.
      // These are not fatal - just log and continue.
      w.addEventListener("messageerror", () => {
        console.error("Worker messageerror (non-fatal)");
      });
    }
  }

  private static async spawnWorkers(
    workerCount: number,
    workerUrl: string,
    sharedMemory: WebAssembly.Memory,
    sharedBuffer: SharedArrayBuffer,
  ): Promise<Worker[]> {
    console.error(`[DEBUG] Spawning ${workerCount} workers`);
    const workers: Worker[] = [];
    const initPromises: Promise<void>[] = [];

    // Spawn workers and wait for ready
    for (let i = 0; i < workerCount; i++) {
      const worker = new Worker(workerUrl, {
        type: "module",
        // @ts-ignore Deno specific
        deno: { permissions: "inherit" },
      });

      initPromises.push(
        // We only need the readiness barrier; discard the payload to keep initPromises typed as Promise<void>[].
        this.waitForWorkerMessage(worker, "ready").then(() => undefined),
      );
      worker.postMessage({
        type: "init",
        memory: sharedMemory,
        sab: sharedBuffer,
        workerId: i,
      });

      workers.push(worker);
    }

    await Promise.all(initPromises);
    return workers;
  }

  private static validateSabExports(
    exports: ArenaWasmExports,
  ): {
    exports: ArenaWasmExports;
    connectArena: (ptr: number) => number;
    debugLockState: () => number;
    getArenaMode: () => number;
    debugGetArenaBaseAddr: () => number;
  } {
    const {
      debugLockState,
      getArenaMode,
      debugGetArenaBaseAddr,
    } = exports;

    if (!exports.initArena || typeof exports.initArena !== "function") {
      throw new Error(
        "initArena export is required but missing. SharedArrayBuffer support is required for ParallelArenaEvaluatorWasm.",
      );
    }
    if (!exports.connectArena || typeof exports.connectArena !== "function") {
      throw new Error(
        "connectArena export is required but missing.",
      );
    }
    if (!debugLockState || typeof debugLockState !== "function") {
      throw new Error("debugLockState export is required but missing");
    }
    if (!getArenaMode || typeof getArenaMode !== "function") {
      throw new Error("getArenaMode export is required but missing");
    }
    if (
      !debugGetArenaBaseAddr ||
      typeof debugGetArenaBaseAddr !== "function"
    ) {
      throw new Error(
        "debugGetArenaBaseAddr export is required but missing",
      );
    }

    return {
      exports,
      connectArena: exports.connectArena as (ptr: number) => number,
      debugLockState,
      getArenaMode,
      debugGetArenaBaseAddr,
    };
  }

  private static async connectWorkersToArena(
    workers: Worker[],
    arenaPointer: number,
  ): Promise<void> {
    const connectPromises = workers.map(async (worker, workerIndex) => {
      try {
        worker.postMessage({
          type: "connectArena",
          arenaPointer,
        });
        const message = await this.waitForWorkerMessage(
          worker,
          "connectArenaComplete",
        );
        if (message.error) {
          // High-signal diagnostic for the workbench/server: connection failures often look like "worker died".
          console.error(
            `[ParallelArenaEvaluatorWasm] worker ${workerIndex} connectArena failed: ${message.error}`,
          );
          throw new Error(message.error);
        }
      } catch (err) {
        console.error(
          `[ParallelArenaEvaluatorWasm] worker ${workerIndex} died during connectArena`,
          err,
        );
        throw err;
      }
    });
    await Promise.all(connectPromises);
  }

  private static waitForWorkerMessage<
    T extends WorkerToMainMessage["type"],
  >(
    worker: Worker,
    messageType: T,
  ): Promise<Extract<WorkerToMainMessage, { type: T }>> {
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        worker.removeEventListener("message", onMessage);
        worker.removeEventListener("error", onError);
      };

      const onError = (err: ErrorEvent) => {
        cleanup();
        reject(err.error instanceof Error ? err.error : new Error(err.message));
      };

      const onMessage = (e: MessageEvent<WorkerToMainMessage>) => {
        const data = e.data;
        if (!data) return;
        if (data.type === messageType) {
          cleanup();
          resolve(data as Extract<WorkerToMainMessage, { type: T }>);
        } else if (data.type === "error") {
          cleanup();
          reject(new Error(data.error ?? "Worker error during handshake"));
        }
      };
      worker.addEventListener("message", onMessage);
      worker.addEventListener("error", onError);
    });
  }

  static async create(
    workerCount = navigator.hardwareConcurrency || 4,
  ): Promise<ParallelArenaEvaluatorWasm> {
    console.error(
      `[DEBUG] ParallelArenaEvaluatorWasm.create called with workerCount: ${workerCount}, navigator.hardwareConcurrency: ${navigator.hardwareConcurrency}`,
    );
    if (workerCount < 1) {
      throw new Error(
        "ParallelArenaEvaluatorWasm requires at least one worker",
      );
    }
    const INITIAL_CAP = 1 << 16; // Use a modest bootstrap cap to fit constrained shared memory in tests.
    const MAX_PAGES = 65536; // 4GB maximum
    const INITIAL_ARENA_PAGES = 128; // ~8MB, should be enough for initial arena + headroom
    const sharedMemory = new WebAssembly.Memory({
      initial: INITIAL_ARENA_PAGES,
      maximum: MAX_PAGES,
      shared: true,
    });

    // NOTE: keep stdout clean for CLI tools (e.g. genForest) that stream JSONL.
    // If you want this, run with `--verbose` at the CLI layer instead.

    if (typeof SharedArrayBuffer === "undefined") {
      throw new Error(
        "SharedArrayBuffer is unavailable; ensure the page is cross-origin isolated (COOP+COEP).",
      );
    }

    const sharedBuffer = sharedMemory.buffer;
    if (!(sharedBuffer instanceof SharedArrayBuffer)) {
      throw new Error(
        "WebAssembly.Memory's buffer was not a SharedArrayBuffer. Verify COOP/COEP headers.",
      );
    }

    const bytes = getEmbeddedReleaseWasm().slice();
    const wasmModule = await WebAssembly.compile(bytes);
    const sharedInstance = await WebAssembly.instantiate(wasmModule, {
      env: {
        memory: sharedMemory,
      },
    } as WebAssembly.Imports);
    const exports = sharedInstance.exports as unknown as ArenaWasmExports;

    // Validate exports
    const validated = this.validateSabExports(exports);

    const arenaPointer = (() => {
      const init = validated.exports.initArena!;
      const result = init(INITIAL_CAP);
      // initArena return codes:
      // - 0: Invalid capacity (not power of 2, or out of valid range)
      // - 1: Out of memory (OOM)
      // - 2: Bounds check failure (allocation logic error)
      // - Any other value: Success (returns the arena header address)
      if (result === 0) {
        throw new Error("initArena failed: invalid capacity or parameters");
      }
      if (result === 1 || result === 2) {
        throw new Error(
          `initArena failed with code ${result} (likely OOM or bounds failure)`,
        );
      }
      return result;
    })();

    const workerUrl = new URL("./arenaWorker.ts", import.meta.url).href;
    const workers = await this.spawnWorkers(
      workerCount,
      workerUrl,
      sharedMemory,
      sharedBuffer,
    );

    await this.connectWorkersToArena(workers, arenaPointer);

    const evaluator = new ParallelArenaEvaluatorWasm(
      exports,
      sharedMemory,
      workers,
    );
    return evaluator;
  }

  /**
   * Offload reduction to WASM workers via the shared SQ/CQ rings (io_uring-style).
   *
   * Contract:
   * - **Submit (SQ)**: host enqueues `{ nodeId, reqId }` using `hostSubmit`.
   * - **Complete (CQ)**: workers dequeue, reduce for `maxSteps` (global), then enqueue `{ resultNodeId, reqId }`.
   *   Workers may also enqueue a **Suspension** node when they run out of traversal gas mid-step; the host must resubmit it.
   * - **Polling**: host drains CQ via `hostPull()`, which returns a packed bigint:
   *   `-1n` if empty, otherwise `(reqId << 32) | resultNodeId`.
   *   Results may arrive out-of-order; `reqId` is used to match completions to callers.
   */
  async reduceAsync(
    expr: SKIExpression,
    max = 0xffffffff,
  ): Promise<SKIExpression> {
    this.$.setMaxSteps?.(max >>> 0);
    const arenaNodeId = this.toArena(expr);
    const resultArenaNodeId = await this.reduceArenaNodeIdAsync(
      arenaNodeId,
      expr,
    );
    return this.fromArena(resultArenaNodeId);
  }

  /**
   * Synchronous reduce is not supported in the parallel evaluator.
   * Call `reduceAsync` instead.
   */
  override reduce(_expr: SKIExpression, _max = 0xffffffff): SKIExpression {
    throw new Error(
      "ParallelArenaEvaluatorWasm.reduce is disabled; use reduceAsync instead.",
    );
  }

  private ensurePoller(hostPull: () => bigint) {
    if (this.pollerStarted) return;
    this.pollerStarted = true;
    const pull = hostPull;
    (async () => {
      let emptyStreak = 0;
      const ex = this.$ as unknown as {
        kindOf: (id: number) => number;
        hostSubmit: (nodeId: number, reqId: number) => number;
      };
      for (;;) {
        if (this.aborted) return;

        // OPTIMIZATION: If no work is pending, hibernate.
        // This prevents burning CPU when the user is staring at the screen doing nothing.
        // Use very short sleeps (1ms) in a loop to check aborted frequently while still saving CPU.
        if (this.pending.size === 0) {
          // Check aborted before sleeping to avoid creating a timer that leaks
          if (this.aborted) return;
          // Sleep in 1ms chunks up to ~50ms total, checking aborted frequently
          for (let i = 0; i < 50; i++) {
            if (this.aborted) return;
            const { promise, cancel } = sleep(1);
            this.activeTimeouts.add(cancel);
            try {
              await promise;
            } finally {
              this.activeTimeouts.delete(cancel);
            }
            if (this.aborted) return;
          }
          continue;
        }

        const packed = pull();
        if (packed === EMPTY) {
          this.ringStats.pullEmpty++;
          // If the CQ is empty, avoid burning CPU by spinning in the microtask queue.
          // Use a short macrotask backoff once we've observed emptiness for a while.
          emptyStreak++;
          if (emptyStreak < 512) {
            await new Promise<void>((r) => queueMicrotask(r));
          } else {
            if (this.aborted) return;
            const { promise, cancel } = sleep(0); // Try 0 first, it might yield but return faster than 1
            this.activeTimeouts.add(cancel);
            try {
              await promise;
            } finally {
              this.activeTimeouts.delete(cancel);
            }
            if (this.aborted) return;
          }
          continue;
        }
        this.ringStats.pullNonEmpty++;
        emptyStreak = 0;
        const reqId = Number((packed >> 32n) & 0xffffffffn) >>> 0;
        const nodeId = Number(packed & 0xffffffffn) >>> 0;

        // If the worker yielded, the nodeId is a Suspension node. Resubmit to continue.
        // (Do not resolve the promise yet; the job is still in-flight.)
        if (ex.kindOf(nodeId) === (ArenaKind.Suspension as number)) {
          // If the caller already gave up / was aborted, drop the yielded work.
          if (!this.pending.has(reqId)) continue;

          // Track resubmissions per work unit to prevent infinite loops from divergent terms.
          // Check BEFORE attempting to resubmit - if limit exceeded, stop this work unit.
          const resubmitCount = (this.reqToResubmitCount.get(reqId) ?? 0) + 1;
          if (resubmitCount > MAX_RESUBMITS_PER_WORK_UNIT) {
            const err = new ResubmissionLimitExceededError(
              reqId,
              resubmitCount,
              MAX_RESUBMITS_PER_WORK_UNIT,
            );
            const workerIndex = this.reqToWorkerIndex.get(reqId) ?? 0;
            const expr = this.reqToExpr.get(reqId);
            this.onRequestError?.(reqId, workerIndex, expr, err.message);
            this.pending.get(reqId)?.reject(err);
            this.pending.delete(reqId);
            this.reqToWorkerIndex.delete(reqId);
            this.reqToExpr.delete(reqId);
            this.reqToResubmitCount.delete(reqId);
            if (workerIndex < this.workerPendingCounts.length) {
              this.workerPendingCounts[workerIndex] = Math.max(
                0,
                (this.workerPendingCounts[workerIndex] ?? 0) - 1,
              );
            }
            continue;
          }
          // Increment resubmit count for this work unit
          this.reqToResubmitCount.set(reqId, resubmitCount);

          const workerIndex = this.reqToWorkerIndex.get(reqId) ?? 0;
          const expr = this.reqToExpr.get(reqId);
          this.onRequestYield?.(
            reqId,
            workerIndex,
            expr,
            nodeId,
            resubmitCount,
          );

          // Retry submitting until queue accepts (unbounded retries when queue is full).
          // The per-work-unit resubmission limit above prevents individual work units
          // from monopolizing resources.
          let rc = ex.hostSubmit(nodeId >>> 0, reqId);
          let fullStreak = 0;
          while (rc === 1) {
            this.ringStats.submitFull++;
            if (this.aborted) return;
            fullStreak++;
            if (fullStreak < 64) {
              await new Promise<void>((r) => queueMicrotask(r));
            } else {
              if (this.aborted) return;
              const { promise, cancel } = sleep(1);
              this.activeTimeouts.add(cancel);
              try {
                await promise;
              } finally {
                this.activeTimeouts.delete(cancel);
              }
              if (this.aborted) return;
            }
            rc = ex.hostSubmit(nodeId >>> 0, reqId);
          }
          if (rc !== 0) {
            const err = new Error(
              `Resubmit failed for reqId ${reqId} with code ${rc}`,
            );
            const workerIndex = this.reqToWorkerIndex.get(reqId) ?? 0;
            const expr = this.reqToExpr.get(reqId);
            this.onRequestError?.(reqId, workerIndex, expr, err.message);
            this.pending.get(reqId)?.reject(err);
            this.pending.delete(reqId);
            this.reqToWorkerIndex.delete(reqId);
            this.reqToExpr.delete(reqId);
            this.reqToResubmitCount.delete(reqId);
            if (workerIndex < this.workerPendingCounts.length) {
              this.workerPendingCounts[workerIndex] = Math.max(
                0,
                (this.workerPendingCounts[workerIndex] ?? 0) - 1,
              );
            }
          }
          continue;
        }

        const cb = this.pending.get(reqId);
        if (cb) {
          this.pending.delete(reqId);
          const workerIndex = this.reqToWorkerIndex.get(reqId) ?? 0;
          const expr = this.reqToExpr.get(reqId);
          if (workerIndex < this.workerPendingCounts.length) {
            this.workerPendingCounts[workerIndex] = Math.max(
              0,
              (this.workerPendingCounts[workerIndex] ?? 0) - 1,
            );
          }
          this.reqToWorkerIndex.delete(reqId);
          this.reqToExpr.delete(reqId);
          this.reqToResubmitCount.delete(reqId);
          this.onRequestCompleted?.(reqId, workerIndex, expr, nodeId);
          cb.resolve(nodeId);
        } else {
          // Completion can race with registration, or belong to a caller that already
          // gave up. Stash it so a future awaiter can still observe it.
          this.completed.set(reqId, nodeId);
          this.ringStats.completionsStashed++;
        }
      }
    })();
  }

  terminate() {
    this.abortAll(new Error("Evaluator terminated"));
  }
}
