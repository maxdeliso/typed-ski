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
import { sleep } from "./async.ts";
import { IoManager } from "./io/ioManager.ts";
import { validateIoRingsConfiguration } from "./io/ioRingsValidator.ts";
import { type ArenaRingStatsSnapshot, RingStats } from "./io/ringStats.ts";
import { CompletionPoller } from "./parallel/completionPoller.ts";
import {
  RequestTracker,
  type RequestTrackerHooks,
} from "./parallel/requestTracker.ts";
import { WorkerManager } from "./parallel/workerManager.ts";

// Re-export for external use
export { ResubmissionLimitExceededError } from "./parallel/requestTracker.ts";
export type { ArenaRingStatsSnapshot } from "./io/ringStats.ts";

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

  // Subcomponents
  private readonly requestTracker: RequestTracker;
  private readonly ioManager: IoManager;
  private readonly completionPoller: CompletionPoller;
  private readonly ringStats: RingStats;

  // State
  private aborted = false;
  private abortError: Error | null = null;
  private readonly activeTimeouts = new Set<() => void>();

  private constructor(
    exports: ArenaWasmExports,
    memory: WebAssembly.Memory,
    workers: Worker[],
  ) {
    super(exports, memory);
    this.workers = workers;

    // Initialize subcomponents
    const hooks: RequestTrackerHooks = {
      onRequestQueued: (reqId, workerIndex, expr) => {
        this.onRequestQueued?.(reqId, workerIndex, expr);
      },
      onRequestCompleted: (reqId, workerIndex, expr, arenaNodeId) => {
        this.onRequestCompleted?.(reqId, workerIndex, expr, arenaNodeId);
      },
      onRequestError: (reqId, workerIndex, expr, error) => {
        this.onRequestError?.(reqId, workerIndex, expr, error);
      },
      onRequestYield: (
        reqId,
        workerIndex,
        expr,
        suspensionNodeId,
        resubmitCount,
      ) => {
        this.onRequestYield?.(
          reqId,
          workerIndex,
          expr,
          suspensionNodeId,
          resubmitCount,
        );
      },
    };

    this.requestTracker = new RequestTracker(hooks);
    this.ringStats = new RingStats();
    this.ioManager = new IoManager(
      exports,
      memory,
      () => this.aborted,
    );
    this.completionPoller = new CompletionPoller(
      this.requestTracker,
      this.ioManager,
      this.ringStats,
      exports,
      () => this.aborted,
    );

    // Set up worker error handling
    WorkerManager.setupErrorHandling(workers, (err) => {
      this.abortAll(err);
    });
  }

  private abortAll(err: Error) {
    if (this.aborted) return;
    this.aborted = true;
    this.abortError = err;
    // Clear all active timeouts to prevent leaks
    for (const cancel of this.activeTimeouts) {
      cancel();
    }
    this.activeTimeouts.clear();
    this.requestTracker.abortAll(err);
    this.ioManager.cleanup();
    this.completionPoller.stop();
    WorkerManager.terminate(this.workers);
  }

  /**
   * Workbench UI helper.
   * Returns per-worker pending counts (best-effort logical assignment).
   */
  getPendingCounts(): number[] {
    return this.requestTracker.getPendingCounts();
  }

  /**
   * Returns the total number of pending requests.
   * This is the authoritative count based on the pending Map.
   */
  getTotalPending(): number {
    return this.requestTracker.getTotalPending();
  }

  getRingStatsSnapshot(): ArenaRingStatsSnapshot {
    return this.ringStats.getSnapshot(
      this.requestTracker.getTotalPending(),
      this.requestTracker.getTotalCompleted(),
    );
  }

  /**
   * Self-test to validate that the arena header and IO rings are correctly configured.
   * This catches issues like out-of-sync header files early.
   */
  private validateIoRingsConfiguration(): void {
    validateIoRingsConfiguration(this.$, this.memory);
  }

  readStdout(maxBytes = 4096): Uint8Array {
    return this.ioManager.readStdout(maxBytes);
  }

  async writeStdin(bytes: Uint8Array): Promise<number> {
    return await this.ioManager.writeStdin(bytes);
  }

  /**
   * Submit an already-allocated arena node id to the worker pool and await the resulting arena node id.
   *
   * Notes:
   * - The number of reduction steps is specified per-request via `maxSteps`.
   * - This is the primitive used by higher-level helpers (e.g. reduceAsync) and tooling (e.g. genForest).
   */
  async reduceArenaNodeIdAsync(
    arenaNodeId: number,
    expr?: SKIExpression,
    maxSteps: number = 0xffffffff,
  ): Promise<number> {
    if (this.aborted) {
      throw this.abortError ?? new Error("Evaluator terminated");
    }
    const ex = this.$ as unknown as {
      hostSubmit?: (nodeId: number, reqId: number, maxSteps: number) => number;
      hostPull?: () => bigint;
    };
    if (!ex.hostPull || !ex.hostSubmit) {
      throw new Error("hostSubmit/hostPull exports are required");
    }

    const nWorkers = Math.max(1, this.workers.length);
    const reqId = this.requestTracker.createRequest(nWorkers, expr);

    // Ensure poller is started
    this.completionPoller.start(ex.hostPull);

    // Check for stashed completion (race condition handling)
    const stashed = this.requestTracker.getStashedCompletion(reqId);
    if (stashed !== undefined) {
      return stashed;
    }

    // Register promise resolver
    const resultPromise = new Promise<number>((resolve, reject) => {
      this.requestTracker.markPending(reqId, resolve, reject);
    });

    // Non-blocking submit: retry until queued, with a fixed cap on retries.
    // 0 = ok, 1 = full, 2 = not connected
    // maxSteps is strictly passed as Uint32
    let rc = ex.hostSubmit(arenaNodeId >>> 0, reqId, maxSteps >>> 0);
    let fullStreak = 0;
    while (rc === 1) {
      this.ringStats.recordSubmitFull();
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
      // retry also includes maxSteps
      rc = ex.hostSubmit(arenaNodeId >>> 0, reqId, maxSteps >>> 0);
    }
    if (rc !== 0) {
      if (rc === 2) this.ringStats.recordSubmitNotConnected();
      const err = new Error(`hostSubmit failed with code ${rc}`);
      this.requestTracker.markError(reqId, err);
      throw err;
    }
    this.ringStats.recordSubmitOk();

    return await resultPromise;
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

  static async create(
    workerCount = navigator.hardwareConcurrency || 4,
    verbose = false,
  ): Promise<ParallelArenaEvaluatorWasm> {
    if (verbose) {
      console.error(
        `[DEBUG] ParallelArenaEvaluatorWasm.create called with workerCount: ${workerCount}, navigator.hardwareConcurrency: ${navigator.hardwareConcurrency}`,
      );
    }
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
    const workers = await WorkerManager.spawnWorkers(
      workerCount,
      workerUrl,
      sharedMemory,
      verbose,
    );

    await WorkerManager.connectWorkersToArena(workers, arenaPointer);

    const evaluator = new ParallelArenaEvaluatorWasm(
      exports,
      sharedMemory,
      workers,
    );

    // Run self-test to validate IO rings configuration
    // This catches header/enum mismatches early
    evaluator.validateIoRingsConfiguration();

    return evaluator;
  }

  /**
   * Offload reduction to WASM workers via the shared SQ/CQ rings (io_uring-style).
   *
   * Contract:
   * - **Submit (SQ)**: host enqueues `{ nodeId, reqId, maxSteps }` using `hostSubmit`.
   * - **Complete (CQ)**: workers dequeue, reduce for the request-specific `maxSteps`, then enqueue `{ resultNodeId, reqId }`.
   *   Workers may also enqueue a **Suspension** node when they run out of traversal gas mid-step; the host must resubmit it.
   * - **Polling**: host drains CQ via `hostPull()`, which returns a packed bigint:
   *   `-1n` if empty, otherwise `(reqId << 32) | resultNodeId`.
   *   Results may arrive out-of-order; `reqId` is used to match completions to callers.
   */
  async reduceAsync(
    expr: SKIExpression,
    max = 0xffffffff,
  ): Promise<SKIExpression> {
    const arenaNodeId = this.toArena(expr);
    const resultArenaNodeId = await this.reduceArenaNodeIdAsync(
      arenaNodeId,
      expr,
      max,
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

  terminate() {
    this.abortAll(new Error("Evaluator terminated"));
  }
}
