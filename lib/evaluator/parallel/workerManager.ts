/**
 * Worker lifecycle management for parallel arena evaluator.
 *
 * Handles worker spawning, initialization, arena connection, and error handling.
 *
 * @module
 */

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
    const workers: Worker[] = [];
    const initPromises: Promise<void>[] = [];

    // Spawn workers and wait for ready
    for (let i = 0; i < workerCount; i++) {
      const worker = new Worker(workerUrl, {
        type: "module",
      });

      initPromises.push(
        // We only need the readiness barrier; discard the payload to keep initPromises typed as Promise<void>[].
        this.waitForWorkerMessage(worker, "ready").then(() => undefined),
      );
      worker.postMessage({
        type: "init",
        memory: sharedMemory,
        workerId: i,
      });

      workers.push(worker);
    }

    await Promise.all(initPromises);
    return workers;
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
          onOOM(err);
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

  /**
   * Terminates all workers.
   */
  static terminate(workers: Worker[]): void {
    workers.forEach((w) => w.terminate());
  }

  /**
   * Waits for a specific message type from a worker.
   */
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
}
