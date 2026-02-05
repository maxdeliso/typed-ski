/**
 * Lock-free ring buffer implementation for arena IO operations.
 *
 * This module provides atomic ring buffer operations for stdin/stdout
 * communication between the main thread and Web Workers.
 *
 * @module
 */

import {
  RING_ENTRIES_INDEX,
  RING_HEAD_INDEX,
  RING_HEADER_BYTES,
  RING_HEADER_U32,
  RING_MASK_INDEX,
  RING_NOT_EMPTY_INDEX,
  RING_NOT_FULL_INDEX,
  RING_TAIL_INDEX,
  SabHeaderField,
} from "../arenaHeader.generated.ts";

export type ArenaRingPayloadKind = "u8" | "u32";

const toInt32 = (value: number): number => value | 0;

/**
 * Lock-free ring buffer view for atomic enqueue/dequeue operations.
 *
 * Implements a lock-free SPSC (Single Producer Single Consumer) ring buffer
 * using atomic operations for thread-safe access from multiple workers.
 */
export class ArenaRingView {
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
    this.entries = headerU32[RING_ENTRIES_INDEX]!;
    this.mask = headerU32[RING_MASK_INDEX]!;
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

  /**
   * Attempts to enqueue a value into the ring buffer.
   * Returns true if successful, false if the ring is full.
   */
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

  /**
   * Attempts to dequeue a value from the ring buffer.
   * Returns the value if successful, null if the ring is empty.
   */
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
            ? this.payloadU8[payloadOffset]!
            : this.payloadU32[payloadOffset >>> 2]!;
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

/**
 * Container for all IO ring buffers (stdin, stdout, stdinWait).
 */
export class ArenaIoRings {
  readonly stdin: ArenaRingView;
  readonly stdout: ArenaRingView;
  readonly stdinWait: ArenaRingView;

  constructor(
    buffer: ArrayBuffer | SharedArrayBuffer,
    baseAddr: number,
    sabHeaderSizeU32: number,
  ) {
    const headerView = new Uint32Array(
      buffer,
      baseAddr,
      sabHeaderSizeU32,
    );
    // Use enum values directly as array indices (they're numeric constants)
    const offsetStdin = headerView[SabHeaderField.OFFSET_STDIN]!;
    const offsetStdout = headerView[SabHeaderField.OFFSET_STDOUT]!;
    const offsetStdinWait = headerView[SabHeaderField.OFFSET_STDIN_WAIT]!;
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
