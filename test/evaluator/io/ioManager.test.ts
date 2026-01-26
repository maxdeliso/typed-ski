/**
 * Unit tests for IoManager component.
 *
 * @module
 */

import { assertEquals, assertRejects } from "std/assert";
import type { ArenaWasmExports } from "../../../lib/evaluator/arenaEvaluator.ts";
import { IoManager } from "../../../lib/evaluator/io/ioManager.ts";

import { SabHeaderField } from "../../../lib/evaluator/arenaHeader.generated.ts";
import { RING_HEADER_U32 } from "../../../lib/evaluator/arenaHeader.generated.ts";

/**
 * Creates a mock ArenaWasmExports with a controllable hostSubmit function.
 */
function createMockExports(
  baseAddr: number,
  hostSubmitImpl: (nodeId: number, reqId: number, maxSteps: number) => number,
): ArenaWasmExports {
  return {
    debugGetArenaBaseAddr: () => baseAddr,
    hostSubmit: hostSubmitImpl,
  } as unknown as ArenaWasmExports;
}

/**
 * Creates a minimal WebAssembly.Memory for testing.
 */
function createTestMemory(): WebAssembly.Memory {
  return new WebAssembly.Memory({
    initial: 10, // 10 pages = 640KB, enough for arena setup
    maximum: 128,
    shared: false,
  });
}

/**
 * Sets up a minimal arena header in memory for IoManager to work with.
 * This initializes the header with ring offsets and initializes the ring buffers.
 */
function setupArenaHeader(memory: WebAssembly.Memory, baseAddr: number): void {
  const buffer = memory.buffer;
  const headerView = new Uint32Array(buffer, baseAddr, 20);

  // Set up minimal header: ring_entries, ring_mask, and offsets
  const RING_ENTRIES = 256;
  headerView[SabHeaderField.RING_ENTRIES] = RING_ENTRIES;
  headerView[SabHeaderField.RING_MASK] = RING_ENTRIES - 1;

  // Calculate ring offsets (simplified layout)
  // Each ring needs: header (192 bytes) + slots (RING_ENTRIES * slot_size)
  // For u8 rings: slot_size = 8 bytes (4 byte seq + 1 byte payload + 3 padding)
  const RING_SLOT_SIZE_U8 = 8;
  const RING_TOTAL_SIZE_U8 = 192 + RING_ENTRIES * RING_SLOT_SIZE_U8;

  // Align to 64-byte boundaries (and ensure 4-byte alignment for Uint32Array)
  const align64 = (n: number) => Math.ceil(n / 64) * 64;
  let offset = align64(80); // After header (20 * 4 = 80 bytes)

  headerView[SabHeaderField.OFFSET_STDIN] = offset;
  offset += RING_TOTAL_SIZE_U8;
  offset = align64(offset);

  headerView[SabHeaderField.OFFSET_STDOUT] = offset;
  offset += RING_TOTAL_SIZE_U8;
  offset = align64(offset);

  headerView[SabHeaderField.OFFSET_STDIN_WAIT] = offset;

  // Initialize ring headers (simplified - just set entries and mask)
  // Ring headers must be 4-byte aligned for Uint32Array access
  // Since align64 ensures 64-byte alignment (which is divisible by 4), offsets are already aligned
  const initRing = (ringOffset: number, entries: number, mask: number) => {
    const ringHeader = new Uint32Array(
      buffer,
      baseAddr + ringOffset,
      RING_HEADER_U32,
    );
    ringHeader[33] = entries; // RING_ENTRIES_INDEX
    ringHeader[32] = mask; // RING_MASK_INDEX
  };

  initRing(
    headerView[SabHeaderField.OFFSET_STDIN],
    RING_ENTRIES,
    RING_ENTRIES - 1,
  );
  initRing(
    headerView[SabHeaderField.OFFSET_STDOUT],
    RING_ENTRIES,
    RING_ENTRIES - 1,
  );
  initRing(
    headerView[SabHeaderField.OFFSET_STDIN_WAIT],
    RING_ENTRIES,
    RING_ENTRIES - 1,
  );
}

Deno.test("IoManager - submitSuspension via wakeStdinWaiters", async (t) => {
  await t.step(
    "successfully submits suspension when hostSubmit returns 0",
    async () => {
      const BASE_ADDR = 1024; // Non-zero base address
      let callCount = 0;
      const mockExports = createMockExports(
        BASE_ADDR,
        (nodeId, reqId, maxSteps) => {
          callCount++;
          assertEquals(nodeId, 42);
          assertEquals(reqId, 100);
          assertEquals(maxSteps, 0);
          return 0; // Success
        },
      );

      const memory = createTestMemory();
      setupArenaHeader(memory, BASE_ADDR);
      const ioManager = new IoManager(mockExports, memory, () => false);

      // Register an IO wait and enqueue a nodeId in stdinWait ring
      ioManager.registerIoWait(42, 100);
      const rings = ioManager.getIoRings();
      rings.stdinWait.tryEnqueue(42);

      // Wake stdin waiters - this should call submitSuspension
      const woken = await ioManager.wakeStdinWaiters(10);

      assertEquals(woken, 1);
      assertEquals(callCount, 1);
      assertEquals(ioManager.isIoWaiting(42), false);
    },
  );

  await t.step(
    "retries submission when hostSubmit returns 1 (queue full)",
    async () => {
      const BASE_ADDR = 1024;
      let callCount = 0;
      const mockExports = createMockExports(
        BASE_ADDR,
        (_nodeId, _reqId, _maxSteps) => {
          callCount++;
          if (callCount < 3) {
            return 1; // Queue full - retry
          }
          return 0; // Success on third attempt
        },
      );

      const memory = createTestMemory();
      setupArenaHeader(memory, BASE_ADDR);
      const ioManager = new IoManager(mockExports, memory, () => false);

      ioManager.registerIoWait(42, 100);
      const rings = ioManager.getIoRings();
      rings.stdinWait.tryEnqueue(42);

      const woken = await ioManager.wakeStdinWaiters(10);

      assertEquals(woken, 1);
      assertEquals(callCount, 3); // Should retry twice before succeeding
      assertEquals(ioManager.isIoWaiting(42), false);
    },
  );

  await t.step(
    "throws error when hostSubmit returns non-zero non-one code",
    async () => {
      const BASE_ADDR = 1024;
      const mockExports = createMockExports(
        BASE_ADDR,
        (_nodeId, _reqId, _maxSteps) => {
          return 2; // Error code
        },
      );

      const memory = createTestMemory();
      setupArenaHeader(memory, BASE_ADDR);
      const ioManager = new IoManager(mockExports, memory, () => false);

      ioManager.registerIoWait(42, 100);
      const rings = ioManager.getIoRings();
      rings.stdinWait.tryEnqueue(42);

      await assertRejects(
        async () => {
          await ioManager.wakeStdinWaiters(10);
        },
        Error,
        "Resubmit failed for reqId 100 with code 2",
      );
    },
  );

  await t.step("throws error when aborted during submission", async () => {
    const BASE_ADDR = 1024;
    let callCount = 0;
    const mockExports = createMockExports(
      BASE_ADDR,
      (_nodeId, _reqId, _maxSteps) => {
        callCount++;
        return 1; // Queue full - will retry
      },
    );

    const memory = createTestMemory();
    setupArenaHeader(memory, BASE_ADDR);
    let aborted = false;
    const ioManager = new IoManager(mockExports, memory, () => aborted);

    ioManager.registerIoWait(42, 100);
    const rings = ioManager.getIoRings();
    rings.stdinWait.tryEnqueue(42);

    // Set aborted flag after first call
    const wakePromise = ioManager.wakeStdinWaiters(10);
    // Wait a bit for the first call, then abort
    await new Promise((r) => setTimeout(r, 10));
    aborted = true;

    await assertRejects(
      async () => {
        await wakePromise;
      },
      Error,
      "Evaluator terminated",
    );
  });
});
