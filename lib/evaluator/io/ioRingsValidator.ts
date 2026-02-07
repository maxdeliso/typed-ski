/**
 * IO rings configuration validation.
 *
 * Validates that the arena header and IO rings are correctly configured.
 * This catches issues like out-of-sync header files early.
 *
 * @module
 */

import type { ArenaWasmExports } from "../arenaEvaluator.ts";
import {
  SABHEADER_HEADER_SIZE_U32,
  SabHeaderField,
} from "../arenaHeader.generated.ts";
import { ArenaIoRings } from "./arenaRing.ts";

/**
 * Self-test to validate that the arena header and IO rings are correctly configured.
 * This catches issues like out-of-sync header files early.
 */
export function validateIoRingsConfiguration(
  exports: ArenaWasmExports,
  memory: WebAssembly.Memory,
): void {
  const baseAddr = exports.debugGetArenaBaseAddr?.();
  if (!baseAddr) {
    throw new Error("Arena base address not available for validation");
  }
  const buffer = memory.buffer;
  const headerView = new Uint32Array(
    buffer,
    baseAddr,
    SABHEADER_HEADER_SIZE_U32,
  );

  // Verify offsets can be read and are valid
  // Use enum values directly as array indices (they're numeric constants)
  const offsetStdin = headerView[SabHeaderField.OFFSET_STDIN];
  const offsetStdout = headerView[SabHeaderField.OFFSET_STDOUT];
  const offsetStdinWait = headerView[SabHeaderField.OFFSET_STDIN_WAIT];

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
    new ArenaIoRings(
      buffer,
      baseAddr,
      SABHEADER_HEADER_SIZE_U32,
    );
  } catch (_e) {
    throw new Error(
      `failed to construct ring views: ${(_e as Error).message}`,
    );
  }
}
