/**
 * Worker lifecycle management for parallel arena evaluator.
 *
 * Handles worker spawning, initialization, arena connection, and error handling.
 *
 * @module
 */

import { isNode } from "../../shared/platform.ts";

let WorkerClass: any;
if (typeof globalThis.Worker !== "undefined") {
  WorkerClass = globalThis.Worker;
}

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
  arenaNodeId: number;
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

/**
 * @internal
 * Manages Web Worker lifecycle for parallel evaluation.
 */
export class WorkerManager {
  /**
   * Spawns and initializes workers.
   */
  static async spawnWorkers(
    workerCount: number,
    workerUrl: string,
    sharedMemory: WebAssembly.Memory,
    verbose = false,
  ): Promise<Worker[]> {
    if (verbose) console.error(`[DEBUG] Spawning ${workerCount} workers`);
    const workers: any[] = [];
    const initPromises: Promise<void>[] = [];

    if (isNode && !WorkerClass) {
      const { Worker: NodeWorker } = await import("node:worker_threads");
      WorkerClass = NodeWorker;
    }

    if (!WorkerClass) {
      throw new Error("Worker is not supported in this environment");
    }

    // Spawn workers and wait for ready
    for (let i = 0; i < workerCount; i++) {
      let worker: any;
      if (isNode) {
        // Node worker needs to be spawned with specific options to support TS if needed,
        // or just point to the entry point.
        // If workerUrl is a file:// URL, we need to convert it.
        let actualUrl = workerUrl;
        if (actualUrl.startsWith("file://")) {
          const { fileURLToPath } = await import("node:url");
          actualUrl = fileURLToPath(actualUrl);
        }

        // We assume arenaWorker.ts has been compiled or is being run directly
        // through Node's TypeScript support.
        // Node's Worker can execute TypeScript directly in Node 25, but this
        // repo still needs transform support for enums and parameter properties.
        worker = new WorkerClass(actualUrl, {
          workerData: { memory: sharedMemory, workerId: i },
          execArgv: ["--experimental-transform-types"],
          type: "module",
        });

        // Node workers use a different event system by default (EventEmitter),
        // but modern Node supports addEventListener on Worker.
      } else {
        worker = new WorkerClass(workerUrl, {
          type: "module",
        });
      }

      initPromises.push(
        this.waitForWorkerMessage(worker, "ready").then(() => undefined),
      );

      if (!isNode) {
        worker.postMessage({
          type: "init",
          memory: sharedMemory,
          workerId: i,
        });
      }

      workers.push(worker);
    }

    await Promise.all(initPromises);
    return workers as unknown as Worker[];
  }

  /**
   * Connects workers to the shared arena.
   */
  static async connectWorkersToArena(
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

  /**
   * Sets up error handling for workers.
   */
  static setupErrorHandling(
    workers: Worker[],
    onOOM: (err: Error) => void,
  ): void {
    for (const w of workers) {
      const errorHandler = (e: any) => {
        const err = isNode
          ? e
          : e.error instanceof Error
            ? e.error
            : new Error(e.message || "Worker error");
        // Only abort all if this is an OOM/memory error
        const isOOM =
          err.message?.includes("out of memory") ||
          err.message?.includes("memory") ||
          err.message?.includes("unreachable") ||
          err.name === "RuntimeError";
        if (isOOM) {
          onOOM(err);
        } else {
          // For non-OOM errors, just log and continue
          console.error("Worker error (non-fatal):", err);
        }
      };

      if (isNode) {
        (w as any).on("error", errorHandler);
        (w as any).on("messageerror", () => {
          console.error("Worker messageerror (non-fatal)");
        });
      } else {
        w.addEventListener("error", errorHandler);
        // Some environments surface failed structured-clone / message errors separately.
        // These are not fatal - just log and continue.
        w.addEventListener("messageerror", () => {
          console.error("Worker messageerror (non-fatal)");
        });
      }
    }
  }

  /**
   * Terminates all workers.
   */
  static terminate(workers: Worker[]): void {
    workers.forEach((w) => w.terminate());
  }

  /**
   * Waits for a specific message type from a worker.
   */
  private static waitForWorkerMessage<T extends WorkerToMainMessage["type"]>(
    worker: any,
    messageType: T,
  ): Promise<Extract<WorkerToMainMessage, { type: T }>> {
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        if (isNode) {
          worker.off("message", onMessage);
          worker.off("error", onError);
        } else {
          worker.removeEventListener("message", onMessage);
          worker.removeEventListener("error", onError);
        }
      };

      const onError = (e: any) => {
        cleanup();
        const err = isNode
          ? e
          : e.error instanceof Error
            ? e.error
            : new Error(e.message || "Worker error");
        reject(err);
      };

      const onMessage = (e: any) => {
        const data = isNode ? e : e.data;
        if (!data) return;
        if (data.type === messageType) {
          cleanup();
          resolve(data as Extract<WorkerToMainMessage, { type: T }>);
        } else if (data.type === "error") {
          cleanup();
          reject(new Error(data.error ?? "Worker error during handshake"));
        }
      };

      if (isNode) {
        if (typeof worker.on !== "function") {
          console.error("[DEBUG] worker.on is not a function!", {
            isNode,
            workerType: typeof worker,
            constructorName: worker.constructor?.name,
            keys: Object.keys(worker),
          });
        }
        worker.on("message", onMessage);
        worker.on("error", onError);
      } else {
        if (typeof worker.addEventListener !== "function") {
          console.error("[DEBUG] worker.addEventListener is not a function!", {
            isNode,
            workerType: typeof worker,
            constructorName: worker.constructor?.name,
            keys: Object.keys(worker),
          });
        }
        worker.addEventListener("message", onMessage);
        worker.addEventListener("error", onError);
      }
    });
  }
}
