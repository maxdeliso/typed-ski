/**
 * @internal
 * Parallel arena evaluator using Web Workers.

 * This module orchestrates the creation of the Shared Memory environment,
 * spawns the worker pool, and manages the main thread's interaction with the
 * shared Core/WASM arena.
 *
 * @module
 */

import type { SKIExpression } from "../ski/expression.ts";
import type { Evaluator } from "./evaluator.ts";
import { SabHeaderField } from "./arenaHeader.generated.ts";
import { ArenaEvaluatorWasm, type ArenaWasmExports } from "./arenaEvaluator.ts";
import {
  formatReleaseWasmLoadInfo,
  getLastReleaseWasmLoadInfo,
  getReleaseWasmBytes,
} from "./arenaWasmLoader.ts";
/** @internal */
export { formatReleaseWasmLoadInfo, getLastReleaseWasmLoadInfo };
import { sleep } from "./async.ts";
import { IoManager } from "./io/ioManager.ts";
import { validateIoRingsConfiguration } from "./io/ioRingsValidator.ts";
import { type ArenaRingStatsSnapshot, RingStats } from "./io/ringStats.ts";
import { CompletionPoller } from "./parallel/completionPoller.ts";
import {
  DEFAULT_MAX_RESUBMITS,
  RequestTracker,
  type RequestTrackerHooks,
} from "./parallel/requestTracker.ts";
import { WorkerManager } from "./parallel/workerManager.ts";
import process from "node:process";
import { pathToFileURL } from "node:url";

/**
 * @internal
 * Re-export for external use
 */
export { ResubmissionLimitExceededError } from "./parallel/requestTracker.ts";
/** @internal */

function resolveArenaWorkerUrl(): string {
  const explicitWorkerPath = process.env["TYPED_SKI_ARENA_WORKER_JS_PATH"];
  if (explicitWorkerPath) {
    return pathToFileURL(explicitWorkerPath).href;
  }
  return new URL("../../dist/arenaWorker.js", import.meta.url).href;
}
export type { ArenaRingStatsSnapshot } from "./io/ringStats.ts";

interface ParallelArenaEvaluatorOptions {
  /**
   * Maximum number of suspension/control-node resubmissions per request.
   *
   * - `0`: unlimited (no resubmission cap)
   * - `N > 0`: reject request after `N` resubmissions
   *
   * Defaults to `DEFAULT_MAX_RESUBMITS`.
   */
  maxResubmits?: number;
}

/**
 * Parallel arena evaluator using Web Workers.
 */
export class ParallelArenaEvaluatorWasm
  extends ArenaEvaluatorWasm
  implements Evaluator
{
  public readonly workers: any[] = [];

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
    options: ParallelArenaEvaluatorOptions = {},
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

    const maxResubmits = options.maxResubmits ?? DEFAULT_MAX_RESUBMITS;
    this.requestTracker = new RequestTracker(hooks, maxResubmits);
    this.ringStats = new RingStats();
    this.ioManager = new IoManager(exports, memory, () => this.aborted);
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
    const baseAddr = this.$.debugGetArenaBaseAddr?.() ?? 0;
    const extra = {
      totalNodes: 0,
      totalSteps: 0,
      totalLinkChaseHops: 0,
      totalConsAllocs: 0,
      totalContAllocs: 0,
      totalSuspAllocs: 0,
      duplicateLostAllocs: 0,
      hashconsHits: 0,
      hashconsMisses: 0,
    };

    if (baseAddr !== 0) {
      const headerView = new DataView(this.memory.buffer, baseAddr);
      const readHeaderU64 = (field: SabHeaderField) =>
        Number(
          headerView.getBigUint64(field * Uint32Array.BYTES_PER_ELEMENT, true),
        );

      extra.totalNodes = readHeaderU64(SabHeaderField.TOTAL_NODES);
      extra.totalSteps = readHeaderU64(SabHeaderField.TOTAL_STEPS);
      extra.totalLinkChaseHops = readHeaderU64(
        SabHeaderField.TOTAL_LINK_CHASE_HOPS,
      );
      extra.totalConsAllocs = readHeaderU64(SabHeaderField.TOTAL_CONS_ALLOCS);
      extra.totalContAllocs = readHeaderU64(SabHeaderField.TOTAL_CONT_ALLOCS);
      extra.totalSuspAllocs = readHeaderU64(SabHeaderField.TOTAL_SUSP_ALLOCS);
      extra.duplicateLostAllocs = readHeaderU64(
        SabHeaderField.DUPLICATE_LOST_ALLOCS,
      );
      extra.hashconsHits = readHeaderU64(SabHeaderField.HASHCONS_HITS);
      extra.hashconsMisses = readHeaderU64(SabHeaderField.HASHCONS_MISSES);
    }

    return this.ringStats.getSnapshot(
      this.requestTracker.getTotalPending(),
      this.requestTracker.getTotalCompleted(),
      extra,
    );
  }

  /**
   * Self-test to validate that the arena header and IO rings are correctly configured.
   * This catches issues like out-of-sync header files early.
   */
  private validateIoRingsConfiguration(): void {
    validateIoRingsConfiguration(this.$, this.memory);
  }

  async readStdout(maxBytes = 4096): Promise<Uint8Array> {
    return await this.ioManager.readStdout(maxBytes);
  }

  async writeStdin(bytes: Uint8Array): Promise<number> {
    return await this.ioManager.writeStdin(bytes);
  }

  /**
   * Submit an already-allocated arena node id to the worker pool and await the resulting arena node id.
   *
   * Notes:
   * - The number of reduction steps is specified per-request via `maxSteps`.
   * - This is the primitive used by higher-level helpers (e.g. reduceAsync).
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
      hostPullV2?: () => bigint;
    };
    if (!ex.hostPullV2 || !ex.hostSubmit) {
      throw new Error("hostSubmit/hostPullV2 exports are required");
    }

    const nWorkers = Math.max(1, this.workers.length);
    const reqId = this.requestTracker.createRequest(nWorkers, expr);

    // Ensure poller is started
    this.completionPoller.start(ex.hostPullV2);

    // Check for stashed completion (race condition handling)
    const stashed = this.requestTracker.getStashedCompletion(reqId);
    if (stashed !== undefined) {
      return stashed;
    }

    // Register promise resolver
    const resultPromise = new Promise<number>((resolve, reject) => {
      this.requestTracker.markPending(reqId, resolve, reject);
    });

    try {
      // Non-blocking submit: retry until queued, with a fixed cap on retries.
      // 0 = ok, 1 = full, 2 = not connected
      // maxSteps is strictly passed as Uint32
      let rc = ex.hostSubmit(arenaNodeId >>> 0, reqId, maxSteps >>> 0);
      let fullStreak = 0;
      while (rc === 1) {
        this.ringStats.recordSubmitFull();
        if (this.aborted) {
          throw this.abortError ?? new Error("Evaluator terminated");
        }
        // Avoid a tight microtask spin if workers are blocked (e.g. CQ full / no progress).
        // Back off to a macrotask so we don't peg a CPU core.
        fullStreak++;
        if (fullStreak < 512) {
          await new Promise<void>((r) => queueMicrotask(r));
        } else {
          const { promise, cancel } = sleep(0); // Try 0 first, it might yield but return faster than 1
          this.activeTimeouts.add(cancel);
          try {
            await promise;
          } finally {
            this.activeTimeouts.delete(cancel);
          }
          if (this.aborted) {
            throw this.abortError ?? new Error("Evaluator terminated");
          }
        }
        // retry also includes maxSteps
        rc = ex.hostSubmit(arenaNodeId >>> 0, reqId, maxSteps >>> 0);
      }
      if (rc !== 0) {
        if (rc === 2) this.ringStats.recordSubmitNotConnected();
        throw new Error(`hostSubmit failed with code ${rc}`);
      }
      this.ringStats.recordSubmitOk();

      return await resultPromise;
    } catch (err) {
      if (err instanceof Error) {
        this.requestTracker.markError(reqId, err);
      } else {
        this.requestTracker.markError(reqId, new Error(String(err)));
      }
      // Await the now-rejected resultPromise to ensure it is handled
      return await resultPromise;
    }
  }

  private static validateSabExports(exports: ArenaWasmExports): {
    exports: ArenaWasmExports;
    connectArena: (ptr: number) => number;
    debugLockState: () => number;
    getArenaMode: () => number;
    debugGetArenaBaseAddr: () => number;
  } {
    const { debugLockState, getArenaMode, debugGetArenaBaseAddr } = exports;

    if (!exports.initArena || typeof exports.initArena !== "function") {
      throw new Error(
        "initArena export is required but missing. SharedArrayBuffer support is required for ParallelArenaEvaluatorWasm.",
      );
    }
    if (!exports.connectArena || typeof exports.connectArena !== "function") {
      throw new Error("connectArena export is required but missing.");
    }
    if (!debugLockState || typeof debugLockState !== "function") {
      throw new Error("debugLockState export is required but missing");
    }
    if (!getArenaMode || typeof getArenaMode !== "function") {
      throw new Error("getArenaMode export is required but missing");
    }
    if (!debugGetArenaBaseAddr || typeof debugGetArenaBaseAddr !== "function") {
      throw new Error("debugGetArenaBaseAddr export is required but missing");
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
    workerCount: number = globalThis.navigator?.hardwareConcurrency ?? 4,
    verbose = false,
    options: ParallelArenaEvaluatorOptions = {},
  ): Promise<ParallelArenaEvaluatorWasm> {
    if (verbose) {
      console.error(
        `[DEBUG] ParallelArenaEvaluatorWasm.create called with workerCount: ${workerCount}, navigator.hardwareConcurrency: ${globalThis.navigator?.hardwareConcurrency ?? "unavailable"}`,
      );
    }
    if (workerCount < 1) {
      throw new Error(
        "ParallelArenaEvaluatorWasm requires at least one worker",
      );
    }
    if (
      options.maxResubmits !== undefined &&
      (!Number.isInteger(options.maxResubmits) || options.maxResubmits < 0)
    ) {
      throw new Error(
        `maxResubmits must be an integer >= 0, got ${options.maxResubmits}`,
      );
    }
    const MAX_ARENA_CAPACITY = 1 << 20; // 1M nodes
    const MAX_PAGES = 65535; // Largest wasm32 memory max expressible by Zig's linker
    const INITIAL_ARENA_PAGES = 257; // ~16MB
    const sharedMemory = new WebAssembly.Memory({
      initial: INITIAL_ARENA_PAGES,
      maximum: MAX_PAGES,
      shared: true,
    });

    // NOTE: keep stdout clean for CLI tools that stream JSONL.
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

    const bytes = await getReleaseWasmBytes();
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
      const result = init(MAX_ARENA_CAPACITY);
      if (result === 0) {
        throw new Error(`initArena failed for capacity ${MAX_ARENA_CAPACITY}`);
      }
      return result;
    })();

    const isBrowser = typeof globalThis.document !== "undefined";
    const workerUrl = isBrowser
      ? "/dist/arenaWorker.js"
      : resolveArenaWorkerUrl();

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
      options,
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
   * - **Complete (CQ)**: workers dequeue, reduce for the request-specific `maxSteps`, then enqueue
   *   `{ nodeId, reqId, eventKind }` where `eventKind` is one of:
   *   `0=Done`, `1=Yield`, `2=IoWait`, `3=Error`.
   * - **Polling**: host drains CQ via `hostPullV2()`, which returns a packed bigint:
   *   `-1n` if empty, otherwise:
   *   - bits `63..32`: `reqId`
   *   - bits `31..30`: `eventKind`
   *   - bits `29..0`: `nodeId` for value completions, or control index for yields/io-waits
   *     (the host reconstructs the tagged control pointer using `CONTROL_PTR_BIT`)
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
