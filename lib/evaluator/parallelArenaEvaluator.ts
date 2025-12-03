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
  expr: SKIExpression;
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
  private readonly pendingRequests = new Map<
    number,
    { resolve: (val: SKIExpression) => void; reject: (err: Error) => void }
  >();
  private nextRequestId = 0;
  private nextWorkerIndex = 0;

  private constructor(
    exports: ArenaWasmExports,
    memory: WebAssembly.Memory,
    workers: Worker[],
  ) {
    super(exports, memory);
    this.workers = workers;
  }

  private static async spawnWorkers(
    workerCount: number,
    workerUrl: string,
    sharedMemory: WebAssembly.Memory,
    sharedBuffer: SharedArrayBuffer,
  ): Promise<Worker[]> {
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
    debugGetLockAcquisitionCount?: () => number;
    debugGetLockReleaseCount?: () => number;
  } {
    const {
      debugLockState,
      getArenaMode,
      debugGetArenaBaseAddr,
      debugGetLockAcquisitionCount,
      debugGetLockReleaseCount,
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
      debugGetLockAcquisitionCount,
      debugGetLockReleaseCount,
    };
  }

  private static async connectWorkersToArena(
    workers: Worker[],
    arenaPointer: number,
  ): Promise<void> {
    const connectPromises = workers.map(async (worker) => {
      worker.postMessage({
        type: "connectArena",
        arenaPointer,
      });
      const message = await this.waitForWorkerMessage(
        worker,
        "connectArenaComplete",
      );
      if (message.error) {
        throw new Error(message.error);
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
    if (workerCount < 1) {
      throw new Error(
        "ParallelArenaEvaluatorWasm requires at least one worker",
      );
    }
    const ESTIMATED_BYTES_PER_NODE = 24;
    const MAX_CAP = 1 << 26; // keep in sync with rust (fits <4GB)
    const INITIAL_CAP = 1 << 16; // Use a modest bootstrap cap to fit constrained shared memory in tests.
    const REQUIRED_BYTES = MAX_CAP * ESTIMATED_BYTES_PER_NODE + 65536;
    const PAGE_SIZE = 65536;
    const MAX_PAGES = Math.min(65536, Math.ceil(REQUIRED_BYTES / PAGE_SIZE));
    const INITIAL_ARENA_PAGES = 128; // ~8MB, should be enough for initial arena + headroom
    const sharedMemory = new WebAssembly.Memory({
      initial: INITIAL_ARENA_PAGES,
      maximum: MAX_PAGES,
      shared: true,
    });

    console.log(
      `[DEBUG] Initial memory: ${sharedMemory.buffer.byteLength} bytes (${
        sharedMemory.buffer.byteLength / 65536
      } pages), expected ${INITIAL_ARENA_PAGES} pages`,
    );

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
      env: { memory: sharedMemory },
    } as WebAssembly.Imports);
    const exports = sharedInstance.exports as unknown as ArenaWasmExports;
    const validated = this.validateSabExports(exports);
    const arenaPointer = (() => {
      const init = validated.exports.initArena!;
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

    evaluator.attachWorkerMessageHandlers();
    return evaluator;
  }

  /**
   * Offload reduction to a worker to keep the main thread responsive.
   */
  async reduceAsync(
    expr: SKIExpression,
    max = 0xffffffff,
  ): Promise<SKIExpression> {
    if (this.workers.length === 0) {
      throw new Error(
        "ParallelArenaEvaluatorWasm was constructed without workers",
      );
    }

    const requestId = this.nextRequestId++;
    const worker = this.workers[this.nextWorkerIndex];
    this.nextWorkerIndex = (this.nextWorkerIndex + 1) % this.workers.length;

    return await new Promise<SKIExpression>((resolve, reject) => {
      this.pendingRequests.set(requestId, { resolve, reject });
      worker.postMessage({ type: "work", id: requestId, expr, max });
    });
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

  private attachWorkerMessageHandlers() {
    this.workers.forEach((worker) => {
      worker.addEventListener(
        "message",
        (e: MessageEvent<WorkerToMainMessage>) => {
          if (e.data.type === "result") {
            const pending = this.pendingRequests.get(e.data.id);
            if (pending) {
              this.pendingRequests.delete(e.data.id);
              pending.resolve(e.data.expr as SKIExpression);
            }
          } else if (e.data.type === "error") {
            const id = e.data.workId ?? e.data.id;
            const err = new Error(
              e.data.error ?? "Worker error with no message",
            );
            if (id === undefined) {
              console.error(err);
              return;
            }

            const pending = this.pendingRequests.get(id);
            if (!pending) {
              console.error(err);
              return;
            }

            this.pendingRequests.delete(id);
            pending.reject(err);
          }
        },
      );
    });
  }

  terminate() {
    this.workers.forEach((w) => w.terminate());
  }
}
