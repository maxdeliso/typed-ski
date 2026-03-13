/**
 * Parallel arena evaluator using Web Workers.
 *
 * This module orchestrates the creation of the Shared Memory environment,
 * spawns the worker pool, and manages the main thread's interaction with the
 * shared C/WASM arena.
 *
 * @module
 */

import type { SKIExpression } from "../ski/expression.ts";
import { SKITerminalSymbol } from "../ski/terminal.ts";
import type { Evaluator } from "./evaluator.ts";
import { ArenaEvaluatorWasm, type ArenaWasmExports } from "./arenaEvaluator.ts";
import { getReleaseWasmBytes } from "./arenaWasmLoader.ts";
import { sleep } from "./async.ts";
import { IoManager } from "./io/ioManager.ts";
import { type ArenaRingStatsSnapshot, RingStats } from "./io/ringStats.ts";
import { CompletionPoller } from "./parallel/completionPoller.ts";
import {
  DEFAULT_MAX_RESUBMITS,
  RequestTracker,
  type RequestTrackerHooks,
} from "./parallel/requestTracker.ts";
import { WorkerManager } from "./parallel/workerManager.ts";
import { validateIoRingsConfiguration } from "./io/ioRingsValidator.ts";

// Re-export for external use
export { ResubmissionLimitExceededError } from "./parallel/requestTracker.ts";
export type { ArenaRingStatsSnapshot } from "./io/ringStats.ts";

export interface ParallelArenaEvaluatorOptions {
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
  private readonly inFlightReductions = new Map<string, Promise<number>>();

  // State
  private aborted = false;
  private abortError: Error | null = null;
  private workersTerminated = false;
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
    this.completionPoller.stop();
    for (const cancel of this.activeTimeouts) {
      cancel();
    }
    this.activeTimeouts.clear();
    this.terminateWorkers();
    this.requestTracker.abortAll(err);
  }

  private terminateWorkers(): void {
    if (this.workersTerminated) return;
    this.workersTerminated = true;
    WorkerManager.terminate(this.workers);
  }

  /**
   * Factory method to create and initialize a parallel evaluator.
   */
  static async create(
    workerCount: number = 4,
    verbose = false,
    options: ParallelArenaEvaluatorOptions = {},
  ): Promise<ParallelArenaEvaluatorWasm> {
    if (!Number.isInteger(workerCount) || workerCount < 1) {
      throw new Error(
        `ParallelArenaEvaluatorWasm.create requires at least one worker; got ${workerCount}`,
      );
    }

    if (verbose) {
      console.error(
        `[DEBUG] ParallelArenaEvaluatorWasm.create workerCount=${workerCount}`,
      );
    }

    if (typeof SharedArrayBuffer === "undefined") {
      throw new Error(
        "SharedArrayBuffer is unavailable; ensure the page is cross-origin isolated (COOP+COEP).",
      );
    }

    const INITIAL_CAP = 1 << 20; // 1M nodes
    const MAX_PAGES = 65536; // 4GB maximum
    const INITIAL_ARENA_PAGES = 1024; // ~64MB

    const sharedMemory = new WebAssembly.Memory({
      initial: INITIAL_ARENA_PAGES,
      maximum: MAX_PAGES,
      shared: true,
    });

    const sharedBuffer = sharedMemory.buffer;
    if (!(sharedBuffer instanceof SharedArrayBuffer)) {
      throw new Error(
        "WebAssembly.Memory's buffer was not a SharedArrayBuffer. Verify COOP/COEP headers.",
      );
    }

    const bytes = await getReleaseWasmBytes();
    const wasmModule = await WebAssembly.compile(bytes);
    let worker_id = 64; // MAX_WORKERS
    const sharedInstance = await WebAssembly.instantiate(wasmModule, {
      env: {
        memory: sharedMemory,
        wasm_get_worker_id: () => worker_id,
        wasm_set_worker_id: (id: number) => {
          worker_id = id;
        },
      },
    } as WebAssembly.Imports);
    const exports = sharedInstance.exports as unknown as WebAssembly.Exports;

    // Validate exports
    const validated = ArenaEvaluatorWasm.normalizeExports(exports);

    const arenaPointer = (() => {
      const init = validated.initArena!;
      const result = init(INITIAL_CAP);
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
      validated,
      sharedMemory,
      workers,
      options,
    );

    // Run self-test to validate IO rings configuration
    evaluator.validateIoRingsConfiguration();

    return evaluator;
  }

  /**
   * Offload reduction to WASM workers via the shared SQ/CQ rings (io_uring-style).
   */
  async reduceArenaNodeIdAsync(
    arenaNodeId: number,
    expr?: SKIExpression,
    maxSteps: number = 0xffffffff,
  ): Promise<number> {
    const normalizedNodeId = arenaNodeId >>> 0;
    const normalizedMaxSteps = maxSteps >>> 0;

    if (expr && !containsIoTerminals(expr)) {
      const inFlightKey = `${normalizedNodeId}:${normalizedMaxSteps}`;
      const existing = this.inFlightReductions.get(inFlightKey);
      if (existing) {
        return await existing;
      }

      const sharedPromise = this.submitReduceArenaNodeIdAsync(
        normalizedNodeId,
        expr,
        normalizedMaxSteps,
      );
      this.inFlightReductions.set(inFlightKey, sharedPromise);

      try {
        return await sharedPromise;
      } finally {
        if (this.inFlightReductions.get(inFlightKey) === sharedPromise) {
          this.inFlightReductions.delete(inFlightKey);
        }
      }
    }

    return await this.submitReduceArenaNodeIdAsync(
      normalizedNodeId,
      expr,
      normalizedMaxSteps,
    );
  }

  private async submitReduceArenaNodeIdAsync(
    arenaNodeId: number,
    expr?: SKIExpression,
    maxSteps: number = 0xffffffff,
  ): Promise<number> {
    if (this.aborted) {
      throw this.abortError ?? new Error("Evaluator terminated");
    }
    const ex = this.$;
    if (!ex.hostPullV2 || !ex.hostSubmit) {
      throw new Error("hostSubmit/hostPullV2 exports are required");
    }

    const nWorkers = Math.max(1, this.workers.length);
    const reqId = this.requestTracker.createRequest(nWorkers, expr);

    const resultPromise = new Promise<number>((resolve, reject) => {
      // markPending internally checks for stashed completions
      this.requestTracker.markPending(reqId, resolve, reject);
    });

    // Ensure poller is started
    this.completionPoller.start(ex.hostPullV2);

    try {
      // Non-blocking submit: retry until queued, with a fixed cap on retries.
      let rc = ex.hostSubmit(arenaNodeId >>> 0, reqId, maxSteps >>> 0);
      let fullStreak = 0;
      while (rc === 1) {
        this.ringStats.recordSubmitFull();
        if (this.aborted) {
          throw (this.abortError ?? new Error("Evaluator terminated"));
        }
        fullStreak++;
        if (fullStreak < 512) {
          await new Promise<void>((r) => queueMicrotask(r));
        } else {
          if (this.aborted) {
            throw (this.abortError ?? new Error("Evaluator terminated"));
          }
          const { promise, cancel } = sleep(0);
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
      return await resultPromise;
    }
  }

  getRingStatsSnapshot(): ArenaRingStatsSnapshot {
    return this.ringStats.getSnapshot(
      this.requestTracker.getTotalPending(),
      this.requestTracker.getTotalCompleted(),
    );
  }

  getPendingCounts(): number[] {
    return this.requestTracker.getPendingCounts();
  }

  getTotalPending(): number {
    return this.requestTracker.getTotalPending();
  }

  validateIoRingsConfiguration(): void {
    validateIoRingsConfiguration(this.$, this.memory);
  }

  async readStdout(maxBytes = 4096): Promise<Uint8Array> {
    return await this.ioManager.readStdout(maxBytes);
  }

  async writeStdin(bytes: Uint8Array): Promise<number> {
    return await this.ioManager.writeStdin(bytes);
  }

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

  override reduce(_expr: SKIExpression, _max = 0xffffffff): SKIExpression {
    throw new Error(
      "ParallelArenaEvaluatorWasm.reduce is disabled; use reduceAsync instead.",
    );
  }

  terminate() {
    this.abortAll(new Error("Evaluator terminated"));
    this.terminateWorkers();
  }
}

function containsIoTerminals(expr: SKIExpression): boolean {
  const stack = [expr];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current.kind === "terminal") {
      if (
        current.sym === SKITerminalSymbol.ReadOne ||
        current.sym === SKITerminalSymbol.WriteOne
      ) {
        return true;
      }
      continue;
    }
    if (current.kind === "non-terminal") {
      stack.push(current.rgt, current.lft);
    }
  }
  return false;
}
