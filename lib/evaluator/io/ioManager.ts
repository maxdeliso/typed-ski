/**
 * IO operations manager for parallel arena evaluator.
 *
 * Handles stdin/stdout operations and manages IO wait suspension wake-ups.
 *
 * @module
 */

import { sleep } from "../async.ts";
import type { ArenaWasmExports } from "../arenaEvaluator.ts";
import { SABHEADER_HEADER_SIZE_U32 } from "../arenaHeader.generated.ts";
import { ArenaIoRings } from "./arenaRing.ts";

/**
 * Maximum number of bytes to read from stdout in a single call.
 *
 * Default: 4096 bytes (4KB)
 * Rationale: This is a standard page size and provides a good balance between
 * memory usage and efficiency. It's large enough to minimize syscall overhead
 * while remaining small enough to avoid excessive memory allocation.
 */
const DEFAULT_STDOUT_READ_SIZE = 4096;

/**
 * Threshold for busy-waiting before yielding to the event loop.
 *
 * Default: 512 iterations
 * Rationale: When a ring buffer is full or a submission queue is busy, we
 * initially use queueMicrotask() for rapid retries (low latency). After 512
 * consecutive failures, we switch to sleep(0) to yield to the event loop,
 * preventing starvation of other tasks. 512 is chosen as a balance:
 * - High enough to avoid unnecessary context switches for transient congestion
 * - Low enough to prevent blocking the event loop and maintain responsiveness
 */
const BUSY_WAIT_THRESHOLD = 512;

/**
 * Manages IO operations (stdin/stdout) and suspension wake-ups.
 */
export class IoManager {
  private ioRingsCache:
    | {
      buffer: ArrayBuffer | SharedArrayBuffer;
      baseAddr: number;
      rings: ArenaIoRings;
    }
    | null = null;
  private readonly ioWait = new Map<number, number>();
  private readonly pendingWaiters = new Set<number>();
  private pendingWakeBudget = 0;
  private readonly activeTimeouts = new Set<() => void>();
  private readonly aborted: () => boolean;

  constructor(
    private readonly exports: ArenaWasmExports,
    private readonly memory: WebAssembly.Memory,
    aborted: () => boolean,
  ) {
    this.aborted = aborted;
  }

  /**
   * Gets or creates the IO rings view.
   */
  getIoRings(): ArenaIoRings {
    const baseAddr = this.exports.debugGetArenaBaseAddr?.();
    if (!baseAddr) {
      throw new Error("Arena base address not available");
    }
    const buffer = this.memory.buffer;
    const cached = this.ioRingsCache;
    if (!cached || cached.buffer !== buffer || cached.baseAddr !== baseAddr) {
      const rings = new ArenaIoRings(
        buffer,
        baseAddr,
        SABHEADER_HEADER_SIZE_U32,
      );
      this.ioRingsCache = { buffer, baseAddr, rings };
      return rings;
    }
    return cached.rings;
  }

  /**
   * Reads bytes from stdout ring buffer.
   */
  readStdout(maxBytes = DEFAULT_STDOUT_READ_SIZE): Uint8Array {
    const rings = this.getIoRings();
    const bytes: number[] = [];
    for (let i = 0; i < maxBytes; i++) {
      const value = rings.stdout.tryDequeue();
      if (value === null) break;
      bytes.push(value);
    }
    return new Uint8Array(bytes);
  }

  /**
   * Writes bytes to stdin ring buffer, blocking until all bytes are written.
   */
  async writeStdin(bytes: Uint8Array): Promise<number> {
    if (this.aborted()) {
      throw new Error("Evaluator terminated");
    }
    const rings = this.getIoRings();
    let written = 0;
    for (const byte of bytes) {
      let fullStreak = 0;
      while (!rings.stdin.tryEnqueue(byte)) {
        if (this.aborted()) {
          throw new Error("Evaluator terminated");
        }
        fullStreak++;
        if (fullStreak < BUSY_WAIT_THRESHOLD) {
          await new Promise<void>((r) => queueMicrotask(r));
        } else {
          if (this.aborted()) {
            throw new Error("Evaluator terminated");
          }
          const { promise, cancel } = sleep(0);
          this.activeTimeouts.add(cancel);
          try {
            await promise;
          } finally {
            this.activeTimeouts.delete(cancel);
          }
          if (this.aborted()) {
            throw new Error("Evaluator terminated");
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
   * Wakes up suspended stdin waiters.
   */
  async wakeStdinWaiters(limit: number): Promise<number> {
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

  /**
   * Registers an IO wait suspension.
   */
  registerIoWait(nodeId: number, reqId: number): void {
    this.ioWait.set(nodeId, reqId);
  }

  /**
   * Checks if a node is waiting for IO.
   */
  isIoWaiting(nodeId: number): boolean {
    return this.ioWait.has(nodeId) || this.pendingWaiters.has(nodeId);
  }

  /**
   * Handles an IO wait suspension from the completion queue.
   * Returns true if the suspension was handled, false if it should be deferred.
   */
  async handleIoWaitSuspension(
    nodeId: number,
    reqId: number,
    submitSuspension: (nodeId: number, reqId: number) => Promise<void>,
  ): Promise<boolean> {
    if (this.pendingWaiters.delete(nodeId)) {
      this.ioWait.delete(nodeId);
      await submitSuspension(nodeId, reqId);
      return true;
    } else if (this.pendingWakeBudget > 0) {
      this.pendingWakeBudget--;
      this.ioWait.delete(nodeId);
      await submitSuspension(nodeId, reqId);
      return true;
    }
    return false;
  }

  /**
   * Cleans up all active timeouts.
   */
  cleanup(): void {
    for (const cancel of this.activeTimeouts) {
      cancel();
    }
    this.activeTimeouts.clear();
    this.ioWait.clear();
    this.pendingWaiters.clear();
    this.pendingWakeBudget = 0;
    this.ioRingsCache = null;
  }

  private async submitSuspension(
    nodeId: number,
    reqId: number,
  ): Promise<void> {
    const ex = this.exports as unknown as {
      hostSubmit?: (nodeId: number, reqId: number, maxSteps: number) => number;
    };
    if (!ex.hostSubmit) {
      throw new Error("hostSubmit export missing");
    }
    let rc = ex.hostSubmit(nodeId >>> 0, reqId >>> 0, 0);
    let fullStreak = 0;
    while (rc === 1) {
      if (this.aborted()) {
        throw new Error("Evaluator terminated");
      }
      fullStreak++;
      if (fullStreak < BUSY_WAIT_THRESHOLD) {
        await new Promise<void>((r) => queueMicrotask(r));
      } else {
        if (this.aborted()) {
          throw new Error("Evaluator terminated");
        }
        const { promise, cancel } = sleep(0);
        this.activeTimeouts.add(cancel);
        try {
          await promise;
        } finally {
          this.activeTimeouts.delete(cancel);
        }
        if (this.aborted()) {
          throw new Error("Evaluator terminated");
        }
      }
      rc = ex.hostSubmit(nodeId >>> 0, reqId >>> 0, 0);
    }
    if (rc !== 0) {
      throw new Error(`Resubmit failed for reqId ${reqId} with code ${rc}`);
    }
  }
}
