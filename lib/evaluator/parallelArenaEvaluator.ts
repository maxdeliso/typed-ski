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
import {
  SABHEADER_HEADER_SIZE_U32,
  SabHeaderField,
} from "./arenaHeader.generated.ts";

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
const SUSPEND_MODE_IO_WAIT = 2;

const RING_HEADER_BYTES = 192;
const RING_HEADER_U32 = RING_HEADER_BYTES / 4;
const RING_HEAD_INDEX = 0;
const RING_NOT_FULL_INDEX = 1;
const RING_TAIL_INDEX = 16;
const RING_NOT_EMPTY_INDEX = 17;
const RING_MASK_INDEX = 32;
const RING_ENTRIES_INDEX = 33;

type ArenaRingPayloadKind = "u8" | "u32";

const toInt32 = (value: number): number => value | 0;

class ArenaRingView {
  private readonly headerI32: Int32Array;
  private readonly slotsI32: Int32Array;
  private readonly payloadU8: Uint8Array;
  private readonly payloadU32: Uint32Array;
  private readonly slotsBase: number;
  private readonly slotBytes: number;
  private readonly slotU32Stride: number;
  private readonly entries: number;
  private readonly mask: number;
  private readonly payloadKind: ArenaRingPayloadKind;

  constructor(
    buffer: ArrayBuffer | SharedArrayBuffer,
    baseAddr: number,
    offset: number,
    payloadKind: ArenaRingPayloadKind,
  ) {
    this.headerI32 = new Int32Array(buffer, baseAddr + offset, RING_HEADER_U32);
    const headerU32 = new Uint32Array(
      buffer,
      baseAddr + offset,
      RING_HEADER_U32,
    );
    this.entries = headerU32[RING_ENTRIES_INDEX];
    this.mask = headerU32[RING_MASK_INDEX];
    this.payloadKind = payloadKind;
    const payloadBytes = payloadKind === "u8" ? 1 : 4;
    this.slotBytes = (4 + payloadBytes + 3) & ~3;
    this.slotU32Stride = this.slotBytes / 4;
    this.slotsBase = baseAddr + offset + RING_HEADER_BYTES;
    this.slotsI32 = new Int32Array(
      buffer,
      this.slotsBase,
      this.entries * this.slotU32Stride,
    );
    this.payloadU8 = new Uint8Array(buffer);
    this.payloadU32 = new Uint32Array(buffer);
  }

  tryEnqueue(value: number): boolean {
    for (;;) {
      const t = Atomics.load(this.headerI32, RING_TAIL_INDEX) >>> 0;
      const slotIndex = (t & this.mask) * this.slotU32Stride;
      const seq = Atomics.load(this.slotsI32, slotIndex) >>> 0;
      const diff = (seq - t) | 0;
      if (diff === 0) {
        const next = (t + 1) >>> 0;
        if (
          Atomics.compareExchange(
            this.headerI32,
            RING_TAIL_INDEX,
            toInt32(t),
            toInt32(next),
          ) === toInt32(t)
        ) {
          const payloadOffset = this.slotsBase + slotIndex * 4 + 4;
          if (this.payloadKind === "u8") {
            this.payloadU8[payloadOffset] = value & 0xff;
          } else {
            this.payloadU32[payloadOffset >>> 2] = value >>> 0;
          }
          Atomics.store(this.slotsI32, slotIndex, toInt32(next));
          Atomics.add(this.headerI32, RING_NOT_EMPTY_INDEX, 1);
          if (typeof Atomics.notify === "function") {
            Atomics.notify(this.headerI32, RING_NOT_EMPTY_INDEX, 1);
          }
          return true;
        }
      } else if (diff < 0) {
        return false;
      }
    }
  }

  tryDequeue(): number | null {
    for (;;) {
      const h = Atomics.load(this.headerI32, RING_HEAD_INDEX) >>> 0;
      const slotIndex = (h & this.mask) * this.slotU32Stride;
      const seq = Atomics.load(this.slotsI32, slotIndex) >>> 0;
      const diff = (seq - ((h + 1) >>> 0)) | 0;
      if (diff === 0) {
        const next = (h + 1) >>> 0;
        if (
          Atomics.compareExchange(
            this.headerI32,
            RING_HEAD_INDEX,
            toInt32(h),
            toInt32(next),
          ) === toInt32(h)
        ) {
          const payloadOffset = this.slotsBase + slotIndex * 4 + 4;
          const value = this.payloadKind === "u8"
            ? this.payloadU8[payloadOffset]
            : this.payloadU32[payloadOffset >>> 2];
          const nextSeq = (h + this.mask + 1) >>> 0;
          Atomics.store(this.slotsI32, slotIndex, toInt32(nextSeq));
          Atomics.add(this.headerI32, RING_NOT_FULL_INDEX, 1);
          if (typeof Atomics.notify === "function") {
            Atomics.notify(this.headerI32, RING_NOT_FULL_INDEX, 1);
          }
          return value;
        }
      } else if (diff < 0) {
        return null;
      }
    }
  }
}

class ArenaIoRings {
  readonly stdin: ArenaRingView;
  readonly stdout: ArenaRingView;
  readonly stdinWait: ArenaRingView;

  constructor(buffer: ArrayBuffer | SharedArrayBuffer, baseAddr: number) {
    const headerView = new Uint32Array(
      buffer,
      baseAddr,
      SABHEADER_HEADER_SIZE_U32,
    );
    const field = SabHeaderField as unknown as Record<string, number>;
    const offsetStdin = headerView[field["OFFSET_STDIN"]];
    const offsetStdout = headerView[field["OFFSET_STDOUT"]];
    const offsetStdinWait = headerView[field["OFFSET_STDIN_WAIT"]];
    this.stdin = new ArenaRingView(buffer, baseAddr, offsetStdin, "u8");
    this.stdout = new ArenaRingView(buffer, baseAddr, offsetStdout, "u8");
    this.stdinWait = new ArenaRingView(
      buffer,
      baseAddr,
      offsetStdinWait,
      "u32",
    );
  }
}

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
  private readonly ioWait = new Map<number, number>();
  private readonly pendingWaiters = new Set<number>();
  private pendingWakeBudget = 0;
  private ioRingsCache:
    | {
      buffer: ArrayBuffer | SharedArrayBuffer;
      baseAddr: number;
      rings: ArenaIoRings;
    }
    | null = null;
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
    this.ioWait.clear();
    this.pendingWaiters.clear();
    this.pendingWakeBudget = 0;
    this.ioRingsCache = null;
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

  private getIoRings(): ArenaIoRings {
    const baseAddr = this.$.debugGetArenaBaseAddr?.();
    if (!baseAddr) {
      throw new Error("Arena base address not available");
    }
    const buffer = this.memory.buffer;
    const cached = this.ioRingsCache;
    if (!cached || cached.buffer !== buffer || cached.baseAddr !== baseAddr) {
      const rings = new ArenaIoRings(buffer, baseAddr);
      this.ioRingsCache = { buffer, baseAddr, rings };
      return rings;
    }
    return cached.rings;
  }

  /**
   * Self-test to validate that the arena header and IO rings are correctly configured.
   * This catches issues like out-of-sync header files early.
   */
  private validateIoRingsConfiguration(): void {
    const baseAddr = this.$.debugGetArenaBaseAddr?.();
    if (!baseAddr) {
      throw new Error("Arena base address not available for validation");
    }
    const buffer = this.memory.buffer;
    const headerView = new Uint32Array(
      buffer,
      baseAddr,
      SABHEADER_HEADER_SIZE_U32,
    );
    const field = SabHeaderField as unknown as Record<string, number>;

    // Check that all required offset fields exist in the enum
    const requiredFields = [
      "OFFSET_STDIN",
      "OFFSET_STDOUT",
      "OFFSET_STDIN_WAIT",
    ];
    const missingFields: string[] = [];
    for (const fieldName of requiredFields) {
      if (field[fieldName] === undefined) {
        missingFields.push(fieldName);
      }
    }

    if (missingFields.length > 0) {
      throw new Error(
        `Arena header enum is missing required fields: ${
          missingFields.join(", ")
        }. ` +
          `This indicates the generated header file is out of sync with the Rust struct. ` +
          `Run 'deno run -A scripts/generate-arena-header.ts' to regenerate.`,
      );
    }

    // Verify offsets can be read and are valid
    const offsetStdin = headerView[field["OFFSET_STDIN"]];
    const offsetStdout = headerView[field["OFFSET_STDOUT"]];
    const offsetStdinWait = headerView[field["OFFSET_STDIN_WAIT"]];

    if (
      offsetStdin === undefined || offsetStdout === undefined ||
      offsetStdinWait === undefined
    ) {
      throw new Error(
        `Failed to read IO ring offsets from header. ` +
          `This indicates the header layout doesn't match the Rust struct. ` +
          `Offsets: stdin=${offsetStdin}, stdout=${offsetStdout}, stdinWait=${offsetStdinWait}`,
      );
    }

    // Verify offsets are within buffer bounds
    const bufferEnd = buffer.byteLength;
    if (
      offsetStdin >= bufferEnd || offsetStdout >= bufferEnd ||
      offsetStdinWait >= bufferEnd
    ) {
      throw new Error(
        `IO ring offsets are out of bounds. ` +
          `Buffer size: ${bufferEnd}, offsets: stdin=${offsetStdin}, stdout=${offsetStdout}, stdinWait=${offsetStdinWait}`,
      );
    }

    // Verify ring entries and mask are valid (read from header)
    const ringEntries = headerView[SabHeaderField.RING_ENTRIES];
    const ringMask = headerView[SabHeaderField.RING_MASK];

    if (ringEntries === 0) {
      throw new Error(
        `Ring entries is zero in header. This indicates invalid header data. ` +
          `Ring entries: ${ringEntries}, mask: ${ringMask}`,
      );
    }

    // Try to construct the ring views - this will catch alignment and construction issues
    try {
      const _rings = new ArenaIoRings(buffer, baseAddr);

      // Verify we can access the ring buffers (they should be constructible)
      // If construction succeeded, the internal state should be valid
      // We'll do a simple smoke test: try to read the ring header
      const stdinHeader = new Int32Array(
        buffer,
        baseAddr + offsetStdin,
        RING_HEADER_U32,
      );
      const stdoutHeader = new Int32Array(
        buffer,
        baseAddr + offsetStdout,
        RING_HEADER_U32,
      );

      // Verify headers are accessible (basic sanity check)
      if (stdinHeader.length === 0 || stdoutHeader.length === 0) {
        throw new Error("Ring headers have zero length");
      }
    } catch (err) {
      if (
        err instanceof Error && (
          err.message.includes("Ring buffers") ||
          err.message.includes("Ring headers") ||
          err.message.includes("Invalid atomic access")
        )
      ) {
        throw err;
      }
      throw new Error(
        `Failed to construct IO ring buffers: ${
          err instanceof Error ? err.message : String(err)
        }. ` +
          `This may indicate the header file is out of sync with the Rust struct. ` +
          `Run 'deno run -A scripts/generate-arena-header.ts' and rebuild.`,
      );
    }
  }

  private async submitSuspension(nodeId: number, reqId: number): Promise<void> {
    const ex = this.$ as unknown as {
      hostSubmit?: (nodeId: number, reqId: number, maxSteps: number) => number;
    };
    if (!ex.hostSubmit) {
      throw new Error("hostSubmit export missing");
    }
    let rc = ex.hostSubmit(nodeId >>> 0, reqId >>> 0, 0);
    let fullStreak = 0;
    while (rc === 1) {
      this.ringStats.submitFull++;
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
      rc = ex.hostSubmit(nodeId >>> 0, reqId >>> 0, 0);
    }
    if (rc !== 0) {
      throw new Error(`Resubmit failed for reqId ${reqId} with code ${rc}`);
    }
  }

  private async wakeStdinWaiters(limit: number): Promise<number> {
    const rings = this.getIoRings();
    let budget = limit + this.pendingWakeBudget;
    this.pendingWakeBudget = 0;
    let woken = 0;

    for (const nodeId of Array.from(this.pendingWaiters)) {
      if (budget <= 0) break;
      const reqId = this.ioWait.get(nodeId);
      if (reqId === undefined) continue;
      this.pendingWaiters.delete(nodeId);
      this.ioWait.delete(nodeId);
      await this.submitSuspension(nodeId, reqId);
      budget--;
      woken++;
    }

    while (budget > 0) {
      const nodeId = rings.stdinWait.tryDequeue();
      if (nodeId === null) break;
      const reqId = this.ioWait.get(nodeId);
      if (reqId === undefined) {
        this.pendingWaiters.add(nodeId);
        budget--;
        continue;
      }
      this.ioWait.delete(nodeId);
      await this.submitSuspension(nodeId, reqId);
      budget--;
      woken++;
    }
    this.pendingWakeBudget = budget;
    return woken;
  }

  readStdout(maxBytes = 4096): Uint8Array {
    const rings = this.getIoRings();
    const bytes: number[] = [];
    for (let i = 0; i < maxBytes; i++) {
      const value = rings.stdout.tryDequeue();
      if (value === null) break;
      bytes.push(value);
    }
    return new Uint8Array(bytes);
  }

  async writeStdin(bytes: Uint8Array): Promise<number> {
    if (this.aborted) {
      throw (this.abortError ?? new Error("Evaluator terminated"));
    }
    const rings = this.getIoRings();
    let written = 0;
    for (const byte of bytes) {
      let fullStreak = 0;
      while (!rings.stdin.tryEnqueue(byte)) {
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
      }
      written++;
    }
    if (written > 0) {
      await this.wakeStdinWaiters(written);
    }
    return written;
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
    // maxSteps is strictly passed as Uint32
    let rc = ex.hostSubmit(arenaNodeId >>> 0, reqId, maxSteps >>> 0);
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
      // retry also includes maxSteps
      rc = ex.hostSubmit(arenaNodeId >>> 0, reqId, maxSteps >>> 0);
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
  ): Promise<Worker[]> {
    console.error(`[DEBUG] Spawning ${workerCount} workers`);
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
    );

    await this.connectWorkersToArena(workers, arenaPointer);

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

  private ensurePoller(hostPull: () => bigint) {
    if (this.pollerStarted) return;
    this.pollerStarted = true;
    const pull = hostPull;
    (async () => {
      let emptyStreak = 0;
      // Prevent main-thread saturation under load by time-slicing CQ drains.
      // Microtask yielding is not sufficient to guarantee rendering; prefer rAF when available.
      const SLICE_BUDGET_MS = 8;
      const MAX_EVENTS_PER_SLICE = 4096;
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
        if (this.aborted) return;
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
      const ex = this.$ as unknown as {
        kindOf: (id: number) => number;
        symOf: (id: number) => number;
        hostSubmit: (nodeId: number, reqId: number, maxSteps: number) => number;
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
          sliceEvents = 0;
          sliceStart = nowMs();
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
          sliceEvents = 0;
          sliceStart = nowMs();
          continue;
        }
        this.ringStats.pullNonEmpty++;
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
          if (!this.pending.has(reqId)) continue;

          if (ex.symOf(nodeId) === SUSPEND_MODE_IO_WAIT) {
            this.ioWait.set(nodeId, reqId);
            if (this.pendingWaiters.delete(nodeId)) {
              this.ioWait.delete(nodeId);
              await this.submitSuspension(nodeId, reqId);
            } else if (this.pendingWakeBudget > 0) {
              this.pendingWakeBudget--;
              this.ioWait.delete(nodeId);
              await this.submitSuspension(nodeId, reqId);
            }
            sliceEvents++;
            await maybeYield();
            continue;
          }

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
          // when resubmitting a suspension, max_steps is ignored by the worker
          // (it uses the suspension's internal hash field for remaining budget), so we pass 0.
          // The worker will read the count from the Suspension node's hash field.
          let rc = ex.hostSubmit(nodeId >>> 0, reqId, 0);
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
            // retry passes 0 max steps for suspensions
            rc = ex.hostSubmit(nodeId >>> 0, reqId, 0);
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
          sliceEvents++;
          await maybeYield();
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
        sliceEvents++;
        await maybeYield();
      }
    })();
  }

  terminate() {
    this.abortAll(new Error("Evaluator terminated"));
  }
}
