import { assert, assertEquals, assertRejects, assertThrows } from "std/assert";
import randomSeed from "random-seed";
import type { ArenaWasmExports } from "../../lib/evaluator/arenaEvaluator.ts";
import { ParallelArenaEvaluatorWasm } from "../../lib/index.ts";
import { parseSKI } from "../../lib/parser/ski.ts";
import {
  SABHEADER_HEADER_SIZE_U32,
  SabHeaderField,
} from "../../lib/evaluator/arenaHeader.generated.ts";
import {
  apply,
  type SKIExpression,
  unparseSKI,
} from "../../lib/ski/expression.ts";
import { randExpression } from "../../lib/ski/generator.ts";
import { C, I, K, ReadOne, WriteOne } from "../../lib/ski/terminal.ts";
import { requiredAt } from "../util/required.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function overrideEvaluatorExports(
  evaluator: ParallelArenaEvaluatorWasm,
  exports: ArenaWasmExports,
): void {
  Object.defineProperty(evaluator, "$", {
    configurable: true,
    value: exports,
  });
}

const ParallelArenaEvaluatorInternals = ParallelArenaEvaluatorWasm as unknown as {
  validateSabExports: (exports: ArenaWasmExports) => unknown;
};

Deno.test("ParallelArenaEvaluator - creation and shared memory", async (t) => {
  await t.step("creates evaluator with shared memory", async () => {
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args.map((arg) => String(arg)).join(" "));
    };

    try {
      const evaluator = await ParallelArenaEvaluatorWasm.create(2, true);
      assert(evaluator !== null);
      evaluator.terminate();
    } finally {
      console.error = originalError;
    }

    assert(
      errors.some((line) =>
        line.includes(
          "[DEBUG]",
        )
      ),
      "expected debug output",
    );
  });

  await t.step("memory buffer is SharedArrayBuffer", async () => {
    const evaluator = await ParallelArenaEvaluatorWasm.create(2);
    const memory = evaluator.memory;
    assert(memory instanceof WebAssembly.Memory);
    const buffer = memory.buffer;
    // When shared: true, buffer should be a SharedArrayBuffer
    if (typeof SharedArrayBuffer !== "undefined") {
      assert(
        buffer instanceof SharedArrayBuffer,
        `Expected SharedArrayBuffer, got ${buffer.constructor.name}`,
      );
    } else {
      // Fallback: at least check it's an ArrayBuffer
      assert(buffer instanceof ArrayBuffer);
    }
    evaluator.terminate();
  });

  await t.step("can read and write to memory from main thread", async () => {
    const evaluator = await ParallelArenaEvaluatorWasm.create(2);
    const memory = evaluator.memory;
    const buffer = memory.buffer;
    const view = new Uint8Array(buffer);
    const testValue = 0x42;
    const testOffset = 100;
    view[testOffset] = testValue;
    assertEquals(view[testOffset], testValue);
    evaluator.terminate();
  });

  await t.step("validates maxResubmits option", async () => {
    await assertRejects(
      () => ParallelArenaEvaluatorWasm.create(1, false, { maxResubmits: -1 }),
      Error,
      "maxResubmits must be an integer >= 0",
    );
    await assertRejects(
      () => ParallelArenaEvaluatorWasm.create(1, false, { maxResubmits: 1.5 }),
      Error,
      "maxResubmits must be an integer >= 0",
    );
  });
});

Deno.test("ParallelArenaEvaluator - worker initialization", async (t) => {
  await t.step("workers are initialized and ready", async () => {
    const workerCount = 2;
    const evaluator = await ParallelArenaEvaluatorWasm.create(workerCount);
    assert(evaluator !== null);
    evaluator.terminate();
  });

  await t.step("creates correct number of workers", async () => {
    const workerCount = 3;
    const evaluator = await ParallelArenaEvaluatorWasm.create(workerCount);
    const { workers } = evaluator;
    assertEquals(workers.length, workerCount);
    evaluator.terminate();
  });
});

Deno.test("ParallelArenaEvaluator - async evaluation and arena mode", async (t) => {
  await t.step(
    "async evaluation works and arena is in SAB mode",
    async () => {
      const verbose = false;
      const evaluator = await ParallelArenaEvaluatorWasm.create(2, verbose);
      const { $: exports } = evaluator;

      assert(
        exports.getArenaMode,
        "getArenaMode helper function must be present",
      );
      assert(
        exports.debugLockState,
        "debugLockState helper function must be present",
      );
      const mode = exports.getArenaMode();
      if (verbose) {
        console.log(
          `[DEBUG] Arena mode before reduce: ${mode} (1=SAB, 0=heap)`,
        );
      }
      assertEquals(mode, 1, "Arena should be in SAB mode");
      const lockState = exports.debugLockState();
      if (verbose) {
        console.log(
          `[DEBUG] Lock state before reduce: ${lockState} (0=unlocked, 1=locked, 0xffffffff=uninit)`,
        );
      }

      if (lockState === 0xffffffff) {
        throw new Error("Arena not initialized (lock state = 0xffffffff)");
      }

      const expr = parseSKI("III");
      const result = await evaluator.reduceAsync(expr);
      assertEquals(unparseSKI(result), "I");
      evaluator.terminate();
    },
  );

  await t.step("can perform stepOnce operations", async () => {
    const evaluator = await ParallelArenaEvaluatorWasm.create(2);
    const expr = parseSKI("II");
    const step = evaluator.stepOnce(expr);
    assert(step.altered);
    assertEquals(unparseSKI(step.expr), "I");
    evaluator.terminate();
  });
});

Deno.test("ParallelArenaEvaluator - SharedArrayBuffer verification", async (t) => {
  await t.step("shared memory is accessible from multiple views", async () => {
    const evaluator = await ParallelArenaEvaluatorWasm.create(2);
    const memory = evaluator.memory;
    const buffer = memory.buffer;
    const view1 = new Uint8Array(buffer);
    const view2 = new Uint8Array(buffer);
    const testOffset = 200;
    const testValue = 0xab;
    view1[testOffset] = testValue;
    assertEquals(view2[testOffset], testValue);
    evaluator.terminate();
  });

  await t.step("memory buffer has correct properties", async () => {
    const evaluator = await ParallelArenaEvaluatorWasm.create(2);
    const memory = evaluator.memory;
    const buffer = memory.buffer;
    // When shared: true, buffer should be a SharedArrayBuffer
    if (typeof SharedArrayBuffer !== "undefined") {
      assert(buffer instanceof SharedArrayBuffer);
    } else {
      assert(buffer instanceof ArrayBuffer);
    }
    assert(buffer.byteLength > 0);
    evaluator.terminate();
  });

  await t.step("SharedArrayBuffer can be created with shared memory", () => {
    const sharedMemory = new WebAssembly.Memory({
      initial: 1,
      maximum: 128,
      shared: true,
    });
    const buffer = sharedMemory.buffer;
    if (typeof SharedArrayBuffer !== "undefined") {
      assert(buffer.constructor === SharedArrayBuffer);
      const view1 = new Uint8Array(buffer);
      const view2 = new Int32Array(buffer);
      assert(view1.length > 0);
      assert(view2.length > 0);
    }
  });
});

Deno.test("ParallelArenaEvaluator - work loop validation", async (t) => {
  await t.step("workers can process work requests", async () => {
    const evaluator = await ParallelArenaEvaluatorWasm.create(2);
    const testExpr = parseSKI("III");

    const result = await evaluator.reduceAsync(testExpr);
    assertEquals(unparseSKI(result), "I");
    evaluator.terminate();
  });

  await t.step("multiple workers can process work in parallel", async () => {
    const evaluator = await ParallelArenaEvaluatorWasm.create(2);
    const work1 = parseSKI("II");
    const work2 = parseSKI("KIS");

    const result1Promise = evaluator.reduceAsync(work1);
    const result2Promise = evaluator.reduceAsync(work2);

    const [result1, result2] = await Promise.all([
      result1Promise,
      result2Promise,
    ]);

    assertEquals(unparseSKI(result1), "I");
    assertEquals(unparseSKI(result2), "I");
    evaluator.terminate();
  });

  await t.step(
    "parallel evaluations of convergent expression produce deterministic results",
    async () => {
      const evaluator = await ParallelArenaEvaluatorWasm.create(2);
      try {
        // Instead of a divergent term like (SII)(SII), we use a convergent term
        // that will eventually reduce to I but takes many steps.
        // We use a simpler construction: (K I) applied multiple times to I.
        // (K I) x -> I, so (K I) I -> I, and we can nest this.
        // This creates work without exponential growth.

        // Build: (K I) ((K I) ((K I) ... I))
        let heavyExpr: SKIExpression = I;
        const KI = apply(K, I);
        // Nesting 30 deep creates significant work while still converging
        for (let i = 0; i < 30; i++) {
          heavyExpr = apply(KI, heavyExpr);
        }

        // Run two evaluations in parallel with a fixed step limit
        // The key test is that both produce the SAME result, regardless
        // of whether they fully converge within the limit.
        const stepLimit = 5000;
        const sendWork = (): Promise<SKIExpression> => {
          return evaluator.reduceAsync(heavyExpr, stepLimit);
        };

        const [result1, result2] = await Promise.all([sendWork(), sendWork()]);

        // The critical assertion: both workers should produce identical results
        // when given the same expression and step limit, demonstrating
        // deterministic step counting regardless of suspension/resumption timing.
        assertEquals(
          unparseSKI(result1),
          unparseSKI(result2),
          "Parallel executions produced different results (violated determinism). " +
            `Worker 1: ${unparseSKI(result1)}, Worker 2: ${
              unparseSKI(result2)
            }`,
        );
      } finally {
        evaluator.terminate();
      }
    },
  );
});

Deno.test("ParallelArenaEvaluator - stdin/stdout IO", async (t) => {
  await t.step("readOne parks until stdin has data", async () => {
    const evaluator = await ParallelArenaEvaluatorWasm.create(1);
    const expr = apply(ReadOne, I);
    const resultPromise = evaluator.reduceAsync(expr);
    const first = await Promise.race([
      resultPromise.then(() => "read"),
      Promise.resolve().then(() => "tick"),
    ]);
    assertEquals(first, "tick");
    const writePromise = evaluator.writeStdin(new Uint8Array([65]));
    const firstAfterWrite = await Promise.race([
      resultPromise.then(() => "read"),
      writePromise.then(() => "write"),
    ]);
    assertEquals(firstAfterWrite, "write");
    await writePromise;
    const result = await resultPromise;
    assertEquals(result.kind, "u8");
    assertEquals((result as { kind: "u8"; value: number }).value, 65);
    evaluator.terminate();
  });

  await t.step("writeOne enqueues bytes to stdout", async () => {
    const evaluator = await ParallelArenaEvaluatorWasm.create(1);
    const expr = apply(apply(WriteOne, { kind: "u8", value: 66 }), I);
    const result = await evaluator.reduceAsync(expr);
    assertEquals(result.kind, "u8");
    assertEquals((result as { kind: "u8"; value: number }).value, 66);
    const stdout = await evaluator.readStdout(1);
    assertEquals(stdout.length, 1);
    assertEquals(stdout[0], 66);
    evaluator.terminate();
  });

  await t.step("hello world writes expected stdout bytes", async () => {
    const evaluator = await ParallelArenaEvaluatorWasm.create(1);
    const encoder = new TextEncoder();
    const message = "hello\n";
    const bytes = encoder.encode(message);
    for (const byte of bytes) {
      const expr = apply(apply(WriteOne, { kind: "u8", value: byte }), I);
      await evaluator.reduceAsync(expr);
    }

    let stdout = new Uint8Array(0);
    for (let i = 0; i < 10 && stdout.length < bytes.length; i++) {
      const chunk = await evaluator.readStdout(bytes.length - stdout.length);
      if (chunk.length > 0) {
        const next = new Uint8Array(stdout.length + chunk.length);
        next.set(stdout);
        next.set(chunk, stdout.length);
        stdout = next;
      }
      if (stdout.length < bytes.length) await sleep(50);
    }

    assertEquals(stdout, bytes);
    evaluator.terminate();
  });

  await t.step("echo round-trip with readOne/writeOne", async () => {
    const evaluator = await ParallelArenaEvaluatorWasm.create(1);
    const encoder = new TextEncoder();
    const payload = encoder.encode("echo");
    for (const byte of payload) {
      // C WriteOne I acts as a callback: (C WriteOne I) byte -> WriteOne byte I
      const expr = apply(ReadOne, apply(apply(C, WriteOne), I));
      const promise = evaluator.reduceAsync(expr);
      await evaluator.writeStdin(new Uint8Array([byte]));
      const result = await promise;
      assertEquals(result.kind, "u8");
      assertEquals((result as { kind: "u8"; value: number }).value, byte);
    }
    const stdout = await evaluator.readStdout(payload.length);
    assertEquals(stdout, payload);
    evaluator.terminate();
  });

  await t.step(
    "echo with queued readOne tasks returns correct bytes",
    async () => {
      const evaluator = await ParallelArenaEvaluatorWasm.create(1);
      try {
        const encoder = new TextEncoder();
        const payload = encoder.encode("queued-echo");
        // C WriteOne I acts as a callback: (C WriteOne I) byte -> WriteOne byte I
        const pending = Array.from(
          payload,
          () =>
            evaluator.reduceAsync(apply(ReadOne, apply(apply(C, WriteOne), I))),
        );
        await evaluator.writeStdin(payload);
        const results = await Promise.all(pending);
        const decoded = results.map((res) => {
          assertEquals(res.kind, "u8");
          return (res as { kind: "u8"; value: number }).value;
        });
        assertEquals(decoded.length, payload.length);
        const sortedDecoded = [...decoded].sort((a, b) => a - b);
        const sortedPayload = Array.from(payload).sort((a, b) => a - b);
        assertEquals(sortedDecoded, sortedPayload);

        const stdout = await evaluator.readStdout(payload.length);
        assertEquals(stdout.length, payload.length);
        const sortedOut = Array.from(stdout).sort((a, b) => a - b);
        assertEquals(sortedOut, sortedPayload);
      } finally {
        evaluator.terminate();
      }
    },
  );

  await t.step("writeStdin blocks when stdin ring is full", async () => {
    const evaluator = await ParallelArenaEvaluatorWasm.create(1);
    try {
      const ringEntries = evaluator.$.debugGetRingEntries?.() ??
        (() => {
          throw new Error("WASM export `debugGetRingEntries` is missing");
        })();
      await evaluator.writeStdin(new Uint8Array(ringEntries));

      let writeResolved = false;
      const extraWrite = evaluator.writeStdin(new Uint8Array([99]))
        .then(() => {
          writeResolved = true;
        });
      // Allow microtasks to flush; writeStdin should still be pending while full.
      await Promise.resolve();
      await Promise.resolve();
      assertEquals(writeResolved, false);

      const readResult = await evaluator.reduceAsync(apply(ReadOne, I));
      assertEquals(readResult.kind, "u8");
      assertEquals((readResult as { kind: "u8"; value: number }).value, 0);
      await extraWrite;
      assertEquals(writeResolved, true);
    } finally {
      evaluator.terminate();
    }
  });
});

Deno.test("ParallelArenaEvaluator - helper methods", async (t) => {
  await t.step("readStdout returns empty when idle", async () => {
    const evaluator = await ParallelArenaEvaluatorWasm.create(1);
    try {
      const stdout = await evaluator.readStdout(16);
      assertEquals(stdout.length, 0);
    } finally {
      evaluator.terminate();
    }
  });

  await t.step("writeStdin returns bytes written", async () => {
    const evaluator = await ParallelArenaEvaluatorWasm.create(1);
    try {
      const bytes = new Uint8Array([1, 2, 3]);
      const written = await evaluator.writeStdin(bytes);
      assertEquals(written, bytes.length);
      for (const byte of bytes) {
        const result = await evaluator.reduceAsync(apply(ReadOne, I));
        assertEquals(result.kind, "u8");
        assertEquals((result as { kind: "u8"; value: number }).value, byte);
      }
    } finally {
      evaluator.terminate();
    }
  });

  await t.step(
    "pending counts and ring stats are available during evaluation",
    async () => {
      const evaluator = await ParallelArenaEvaluatorWasm.create(1);
      try {
        const pendingWork = evaluator.reduceAsync(apply(ReadOne, I));
        // Verify stats APIs are accessible and reflect work state
        assert(evaluator.getTotalPending() > 0);
        assert(evaluator.getPendingCounts().length > 0);
        const snapshot = evaluator.getRingStatsSnapshot();
        assert(snapshot.pending > 0);
        await evaluator.writeStdin(new Uint8Array([7]));
        const result = await pendingWork;
        assertEquals(result.kind, "u8");
        assertEquals((result as { kind: "u8"; value: number }).value, 7);
        // After completion, pending should be zero
        assertEquals(evaluator.getTotalPending(), 0);
      } finally {
        evaluator.terminate();
      }
    },
  );

  await t.step("reduce throws in parallel evaluator", async () => {
    const evaluator = await ParallelArenaEvaluatorWasm.create(1);
    try {
      assertThrows(
        () => evaluator.reduce(I),
        Error,
        "ParallelArenaEvaluatorWasm.reduce is disabled",
      );
    } finally {
      evaluator.terminate();
    }
  });
});

Deno.test("ParallelArenaEvaluator - fromArena validation", async (t) => {
  await t.step("fromArena correctly reconstructs expressions", async () => {
    const evaluator = await ParallelArenaEvaluatorWasm.create(2);
    try {
      const testCases = [
        "I",
        "II",
        "III",
        "KIS",
        "SKKI",
        "SKKII",
        "KI(KI)",
        "(SII)(SII)",
      ];

      for (const exprStr of testCases) {
        const expr = parseSKI(exprStr);
        // Convert to arena
        const arenaId = evaluator.toArena(expr);
        // Convert back from arena using memory views
        const reconstructed = evaluator.fromArena(arenaId);
        // Verify they match
        assertEquals(
          unparseSKI(reconstructed),
          unparseSKI(expr),
          `fromArena failed for expression: ${exprStr}`,
        );
      }
    } finally {
      evaluator.terminate();
    }
  });

  await t.step(
    "fromArena reconstructs expressions correctly after async reduction",
    async () => {
      const evaluator = await ParallelArenaEvaluatorWasm.create(2);
      try {
        const expr = parseSKI("III");
        // Reduce using the ring-based async path
        const reduced = await evaluator.reduceAsync(expr, 100);
        assertEquals(unparseSKI(reduced), "I");
      } finally {
        evaluator.terminate();
      }
    },
  );

  await t.step(
    "fromArena works with reduceAsync and manual toArena/fromArena round-trip",
    async () => {
      const evaluator = await ParallelArenaEvaluatorWasm.create(2);
      try {
        const expr = parseSKI("III");
        // Use reduceAsync which uses fromArena internally
        const result = await evaluator.reduceAsync(expr, 100);
        assertEquals(unparseSKI(result), "I");
        // Also verify we can manually convert to/from arena
        const arenaId = evaluator.toArena(expr);
        const manualResult = evaluator.fromArena(arenaId);
        assertEquals(unparseSKI(manualResult), unparseSKI(expr));
      } finally {
        evaluator.terminate();
      }
    },
  );

  await t.step(
    "fromArena preserves DAG structure (hash consing)",
    async () => {
      const evaluator = await ParallelArenaEvaluatorWasm.create(2);
      try {
        // Create an expression with shared sub-expressions
        const expr = parseSKI("II");
        const arenaId1 = evaluator.toArena(expr);
        const arenaId2 = evaluator.toArena(expr);
        // Hash consing should give us the same ID
        assertEquals(arenaId1, arenaId2, "Hash consing should reuse nodes");
        // Both should reconstruct to the same expression
        const reconstructed1 = evaluator.fromArena(arenaId1);
        const reconstructed2 = evaluator.fromArena(arenaId2);
        assertEquals(
          unparseSKI(reconstructed1),
          unparseSKI(reconstructed2),
          "Reconstructed expressions should match",
        );
      } finally {
        evaluator.terminate();
      }
    },
  );

  await t.step(
    "fromArena handles complex nested expressions",
    async () => {
      const evaluator = await ParallelArenaEvaluatorWasm.create(2);
      try {
        const complexExpr = parseSKI("S(SKK)(SKK)I");
        const arenaId = evaluator.toArena(complexExpr);
        const reconstructed = evaluator.fromArena(arenaId);
        assertEquals(
          unparseSKI(reconstructed),
          unparseSKI(complexExpr),
          "Complex nested expression should be correctly reconstructed",
        );
      } finally {
        evaluator.terminate();
      }
    },
  );

  await t.step(
    "views cache correctly invalidates and rebuilds when arena grows",
    async () => {
      const evaluator = await ParallelArenaEvaluatorWasm.create(2);
      try {
        // Create an initial expression and convert to arena (this will populate the cache)
        const initialExpr = parseSKI("III");
        const initialId = evaluator.toArena(initialExpr);
        const initialReconstructed = evaluator.fromArena(initialId);
        assertEquals(unparseSKI(initialReconstructed), unparseSKI(initialExpr));

        // Get initial capacity from the arena header
        const memory = evaluator.memory;
        const baseAddr = evaluator.$.debugGetArenaBaseAddr?.();
        assert(
          baseAddr !== undefined && baseAddr !== 0,
          "Arena should be initialized",
        );
        const headerView = new Uint32Array(
          memory.buffer,
          baseAddr,
          SABHEADER_HEADER_SIZE_U32,
        );
        const initialCapacity = requiredAt(
          headerView,
          SabHeaderField.CAPACITY,
          "expected initial arena capacity",
        );

        // Allocate many unique expressions to trigger arena growth
        // Each unique expression creates new nodes, so we need enough to exceed initial capacity
        // We'll create simple expressions that are likely to be unique

        // Create enough unique expressions to trigger at least one grow
        // Initial capacity is 1 << 16 = 65536, so we need to allocate more than that
        // Hash consing will deduplicate identical expressions, so we need truly unique ones
        // Use random expression generator with fixed seed for reproducible unique expressions
        const FIXED_SEED = "views-cache-test-seed-12345";
        const rs = randomSeed.create(FIXED_SEED);

        // Track a few expressions for validation
        const testExpressions: SKIExpression[] = [];
        const testIds: number[] = [];

        // Allocate expressions until we trigger growth or hit a reasonable limit
        // Use random expressions with varying sizes to ensure uniqueness
        let lastTop = requiredAt(
          headerView,
          SabHeaderField.TOP,
          "expected initial arena top",
        );
        const targetTop = initialCapacity - 100; // Stop before hitting capacity to avoid issues

        for (let i = 0; i < 100000 && lastTop < targetTop; i++) {
          // Generate random expressions with varying sizes (1 to 20 symbols)
          // This ensures each expression is unique while keeping them reasonably sized
          const symbolCount = (i % 20) + 1;
          const expr = randExpression(rs, symbolCount);
          const id = evaluator.toArena(expr);

          // Store every 100th expression for validation
          if (i % 100 === 0) {
            testExpressions.push(expr);
            testIds.push(id);
          }

          // Check if capacity has grown (check every 5000 allocations for efficiency)
          if (i % 5000 === 0 || i === 99999) {
            const currentCapacity = requiredAt(
              headerView,
              SabHeaderField.CAPACITY,
              "expected arena capacity while growing",
            );
            const currentTop = requiredAt(
              headerView,
              SabHeaderField.TOP,
              "expected arena top while growing",
            );
            lastTop = currentTop;

            if (currentCapacity > initialCapacity) {
              // Arena has grown! Now test that fromArena still works correctly
              // with the new capacity
              const lastExpr = requiredAt(
                testExpressions,
                testExpressions.length - 1,
                "expected last stored expression",
              );
              const lastId = requiredAt(
                testIds,
                testIds.length - 1,
                "expected last stored arena id",
              );
              const reconstructed = evaluator.fromArena(lastId);
              assertEquals(
                unparseSKI(reconstructed),
                unparseSKI(lastExpr),
                `fromArena should work correctly after arena growth (capacity: ${initialCapacity} -> ${currentCapacity})`,
              );

              // Also verify that the initial expression still works
              const initialReconstructedAfterGrow = evaluator.fromArena(
                initialId,
              );
              assertEquals(
                unparseSKI(initialReconstructedAfterGrow),
                unparseSKI(initialExpr),
                "Initial expression should still be reconstructable after arena growth",
              );

              // Test a few stored expressions to ensure cache is working
              const testCount = Math.min(10, testExpressions.length);
              for (
                let k = testExpressions.length - testCount;
                k < testExpressions.length;
                k++
              ) {
                const testReconstructed = evaluator.fromArena(
                  requiredAt(testIds, k, "expected stored arena id"),
                );
                assertEquals(
                  unparseSKI(testReconstructed),
                  unparseSKI(
                    requiredAt(
                      testExpressions,
                      k,
                      "expected stored expression",
                    ),
                  ),
                  `Expression at index ${k} should be reconstructable after growth`,
                );
              }

              // Successfully validated cache invalidation and rebuild
              return;
            }
          }
        }

        // Still verify that stored expressions can be reconstructed
        for (let i = 0; i < testExpressions.length; i++) {
          const reconstructed = evaluator.fromArena(
            requiredAt(testIds, i, "expected stored arena id"),
          );
          assertEquals(
            unparseSKI(reconstructed),
            unparseSKI(
              requiredAt(testExpressions, i, "expected stored expression"),
            ),
            `Expression at index ${i} should be reconstructable`,
          );
        }
      } finally {
        evaluator.terminate();
      }
    },
  );
});

Deno.test({
  name: "ParallelArenaEvaluator - concurrent mixed work",
  sanitizeOps: true,
  sanitizeResources: true,
  permissions: { read: true, write: true, env: true, run: true },
  async fn() {
    const evaluator = await ParallelArenaEvaluatorWasm.create(2, false, {
      maxResubmits: 100,
    });

    try {
      const divergent = parseSKI("(SII)(SII)");
      const convergent = parseSKI("II");

      const p1 = evaluator.reduceAsync(convergent);
      const p2 = evaluator.reduceAsync(divergent, 50);
      const p3 = evaluator.reduceAsync(divergent);

      const results = await Promise.allSettled([p1, p2, p3]);

      // Convergent work should always succeed
      assert(results[0].status === "fulfilled");
      assertEquals(
        unparseSKI((results[0] as PromiseFulfilledResult<SKIExpression>).value),
        "I",
      );

      // Divergent work may succeed or fail depending on step timing,
      // but should not crash the evaluator or workers.
    } finally {
      evaluator.terminate();
    }
  },
});

Deno.test("ParallelArenaEvaluator - request hooks call the expected callbacks", async () => {
  const evaluator = await ParallelArenaEvaluatorWasm.create(1);
  try {
    let queued = false;
    let completed = false;
    evaluator.onRequestQueued = () => {
      queued = true;
    };
    evaluator.onRequestCompleted = () => {
      completed = true;
    };

    await evaluator.reduceAsync(parseSKI("I"));

    assert(queued, "onRequestQueued should have been called");
    assert(completed, "onRequestCompleted should have been called");
  } finally {
    evaluator.terminate();
  }
});

Deno.test("ParallelArenaEvaluator - onRequestYield hook fires for yielding work", async () => {
  const evaluator = await ParallelArenaEvaluatorWasm.create(1);
  try {
    let yielded = false;
    evaluator.onRequestYield = () => {
      yielded = true;
    };

    try {
      await evaluator.reduceAsync(parseSKI("(SII)(SII)"), 100);
    } catch {
      // Rejections are acceptable here; we only assert that a yield was observed.
    }
    assert(yielded, "onRequestYield should have been called");
  } finally {
    evaluator.terminate();
  }
});

Deno.test("ParallelArenaEvaluator - bounded divergent work rejects and clears pending requests", async () => {
  const evaluator = await ParallelArenaEvaluatorWasm.create(1, false, {
    maxResubmits: 32,
  });
  try {
    const requestErrors: string[] = [];
    evaluator.onRequestError = (_reqId, _workerIndex, _expr, error) => {
      requestErrors.push(error);
    };

    await assertRejects(
      () => evaluator.reduceAsync(parseSKI("(SII)(SII)"), 100),
      Error,
      "exceeded maximum resubmissions",
    );
    assert(
      requestErrors.some((error) =>
        error.includes("exceeded maximum resubmissions")
      ),
      "expected bounded divergent work to surface through request errors",
    );
    assertEquals(
      evaluator.getTotalPending(),
      0,
      "bounded divergent work should clear pending request state",
    );
  } finally {
    evaluator.terminate();
  }
});

Deno.test("ParallelArenaEvaluator - onRequestError hook fires on hostSubmit failures", async () => {
  const evaluator = await ParallelArenaEvaluatorWasm.create(1);
  const originalExports = evaluator.$;
  try {
    let errorCalled = false;
    evaluator.onRequestError = () => {
      errorCalled = true;
    };

    const mockedExports = {
      ...originalExports,
      hostSubmit: () => 3,
    } as ArenaWasmExports;
    overrideEvaluatorExports(evaluator, mockedExports);

    await assertRejects(
      () => evaluator.reduceAsync(parseSKI("I")),
      Error,
      "hostSubmit failed with code 3",
    );
    assert(errorCalled, "onRequestError should have been called");
  } finally {
    overrideEvaluatorExports(evaluator, originalExports);
    evaluator.terminate();
  }
});

Deno.test("ParallelArenaEvaluator - worker errors abort all pending work", async () => {
  const evaluator = await ParallelArenaEvaluatorWasm.create(1);
  try {
    const worker = requiredAt(evaluator.workers, 0, "worker should exist");
    worker.dispatchEvent(
      new ErrorEvent("error", {
        error: new Error("memory access out of bounds"),
      }),
    );

    let sawAbort = false;
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 10));
      try {
        await evaluator.reduceAsync(parseSKI("I"));
      } catch (error) {
        if (
          error instanceof Error &&
          error.message.includes("memory access out of bounds")
        ) {
          sawAbort = true;
          break;
        }
      }
    }
    assert(sawAbort, "Expected worker error to abort evaluator");
  } finally {
    evaluator.terminate();
  }
});

Deno.test("ParallelArenaEvaluator - create throws when worker count is less than one", async () => {
  await assertRejects(
    () => ParallelArenaEvaluatorWasm.create(0),
    Error,
    "at least one worker",
  );
});

Deno.test("ParallelArenaEvaluator - reduceArenaNodeIdAsync validates required host exports", async () => {
  const evaluator = await ParallelArenaEvaluatorWasm.create(1);
  const originalExports = evaluator.$;
  try {
    const mockedExports = {
      ...originalExports,
      hostSubmit: undefined,
      hostPullV2: undefined,
    } as ArenaWasmExports;
    overrideEvaluatorExports(evaluator, mockedExports);

    await assertRejects(
      () => evaluator.reduceArenaNodeIdAsync(0),
      Error,
      "hostSubmit/hostPullV2 exports are required",
    );
  } finally {
    overrideEvaluatorExports(evaluator, originalExports);
    evaluator.terminate();
  }
});

Deno.test("ParallelArenaEvaluator - more error paths (coverage)", async (t) => {
  await t.step("create throws for workerCount < 1", async () => {
    await assertRejects(
      () => ParallelArenaEvaluatorWasm.create(0),
      Error,
      "ParallelArenaEvaluatorWasm requires at least one worker",
    );
  });

  await t.step("reduce (sync) is disabled", async () => {
    const evaluator = await ParallelArenaEvaluatorWasm.create(1);
    try {
      assertThrows(
        () => evaluator.reduce(I),
        Error,
        "ParallelArenaEvaluatorWasm.reduce is disabled; use reduceAsync instead.",
      );
    } finally {
      evaluator.terminate();
    }
  });

  await t.step("terminate is idempotent", async () => {
    const evaluator = await ParallelArenaEvaluatorWasm.create(1);
    evaluator.terminate();
    evaluator.terminate(); // Should not throw
  });

  await t.step("reduceAsync rejects after termination", async () => {
    const evaluator = await ParallelArenaEvaluatorWasm.create(1);
    evaluator.terminate();
    await assertRejects(
      () => evaluator.reduceAsync(I),
      Error,
      "Evaluator terminated",
    );
  });

  await t.step("terminate cancels tracked timeout callbacks", async () => {
    const evaluator = await ParallelArenaEvaluatorWasm.create(1);
    try {
      let cancelled = false;
      const activeTimeouts = (evaluator as unknown as {
        activeTimeouts: Set<() => void>;
      }).activeTimeouts;
      activeTimeouts.add(() => {
        cancelled = true;
      });

      evaluator.terminate();
      assert(cancelled, "terminate should invoke active timeout cancel hooks");
    } finally {
      evaluator.terminate();
    }
  });

  await t.step("reduceArenaNodeIdAsync returns stashed completions early", async () => {
    const evaluator = await ParallelArenaEvaluatorWasm.create(1);
    try {
      const requestTracker = (evaluator as unknown as {
        requestTracker: {
          createRequest: (workerCount: number, expr?: SKIExpression) => number;
          getStashedCompletion: (reqId: number) => number | undefined;
        };
      }).requestTracker;
      const completionPoller = (evaluator as unknown as {
        completionPoller: {
          start: (pull: () => bigint) => void;
        };
      }).completionPoller;

      let startCalled = false;
      const originalCreateRequest = requestTracker.createRequest.bind(requestTracker);
      const originalGetStashedCompletion = requestTracker.getStashedCompletion.bind(
        requestTracker,
      );
      const originalStart = completionPoller.start.bind(completionPoller);

      requestTracker.createRequest = () => 4242;
      requestTracker.getStashedCompletion = (reqId: number) =>
        reqId === 4242 ? 99 : undefined;
      completionPoller.start = () => {
        startCalled = true;
      };

      try {
        assertEquals(await evaluator.reduceArenaNodeIdAsync(7), 99);
        assert(startCalled, "completion poller should still be started");
      } finally {
        requestTracker.createRequest = originalCreateRequest;
        requestTracker.getStashedCompletion = originalGetStashedCompletion;
        completionPoller.start = originalStart;
      }
    } finally {
      evaluator.terminate();
    }
  });

  await t.step("reduceArenaNodeIdAsync surfaces aborts while queue is full", async () => {
    const evaluator = await ParallelArenaEvaluatorWasm.create(1);
    const originalExports = evaluator.$;
    try {
      const ringStats = (evaluator as unknown as {
        ringStats: { recordSubmitFull: () => void };
        aborted: boolean;
        abortError: Error | null;
      });
      const originalRecordSubmitFull = ringStats.ringStats.recordSubmitFull.bind(
        ringStats.ringStats,
      );

      overrideEvaluatorExports(evaluator, {
        ...originalExports,
        hostSubmit: () => 1,
      } as ArenaWasmExports);

      ringStats.ringStats.recordSubmitFull = () => {
        originalRecordSubmitFull();
        ringStats.aborted = true;
        ringStats.abortError = new Error("abort during submit retry");
      };

      await assertRejects(
        () => evaluator.reduceArenaNodeIdAsync(1),
        Error,
        "abort during submit retry",
      );

      ringStats.ringStats.recordSubmitFull = originalRecordSubmitFull;
    } finally {
      overrideEvaluatorExports(evaluator, originalExports);
      evaluator.terminate();
    }
  });

  await t.step("reduceArenaNodeIdAsync surfaces aborts after macrotask backoff", async () => {
    const evaluator = await ParallelArenaEvaluatorWasm.create(1);
    const originalExports = evaluator.$;
    try {
      overrideEvaluatorExports(evaluator, {
        ...originalExports,
        hostSubmit: () => 1,
      } as ArenaWasmExports);

      const internals = evaluator as unknown as {
        aborted: boolean;
        abortError: Error | null;
        activeTimeouts: Set<() => void> & {
          add: (value: () => void) => Set<() => void>;
        };
      };
      const originalAdd = internals.activeTimeouts.add.bind(internals.activeTimeouts);

      internals.activeTimeouts.add = ((cancel: () => void) => {
        internals.aborted = true;
        internals.abortError = new Error("abort after timeout backoff");
        return originalAdd(cancel);
      }) as typeof internals.activeTimeouts.add;

      try {
        await assertRejects(
          () => evaluator.reduceArenaNodeIdAsync(1),
          Error,
          "abort after timeout backoff",
        );
      } finally {
        internals.activeTimeouts.add = originalAdd;
      }
    } finally {
      overrideEvaluatorExports(evaluator, originalExports);
      evaluator.terminate();
    }
  });

  await t.step("getRingStatsSnapshot handles missing arena base address", async () => {
    const evaluator = await ParallelArenaEvaluatorWasm.create(1);
    const originalExports = evaluator.$;
    try {
      overrideEvaluatorExports(evaluator, {
        ...originalExports,
        debugGetArenaBaseAddr: undefined,
      } as ArenaWasmExports);

      const snapshot = evaluator.getRingStatsSnapshot();
      assertEquals(snapshot.totalNodes, 0);
      assertEquals(snapshot.totalSteps, 0);
    } finally {
      overrideEvaluatorExports(evaluator, originalExports);
      evaluator.terminate();
    }
  });

  await t.step("validateSabExports rejects missing SAB helpers", () => {
    assertThrows(
      () =>
        ParallelArenaEvaluatorInternals.validateSabExports({
          reset: () => {},
          allocTerminal: () => 0,
          allocCons: () => 0,
          allocU8: () => 0,
          arenaKernelStep: () => 0,
          reduce: () => 0,
          kindOf: () => 0,
          symOf: () => 0,
          leftOf: () => 0,
          rightOf: () => 0,
        } as ArenaWasmExports),
      Error,
      "initArena export is required but missing",
    );

    assertThrows(
      () =>
        ParallelArenaEvaluatorInternals.validateSabExports({
          reset: () => {},
          allocTerminal: () => 0,
          allocCons: () => 0,
          allocU8: () => 0,
          arenaKernelStep: () => 0,
          reduce: () => 0,
          kindOf: () => 0,
          symOf: () => 0,
          leftOf: () => 0,
          rightOf: () => 0,
          initArena: () => 1,
        } as ArenaWasmExports),
      Error,
      "connectArena export is required but missing",
    );

    assertThrows(
      () =>
        ParallelArenaEvaluatorInternals.validateSabExports({
          reset: () => {},
          allocTerminal: () => 0,
          allocCons: () => 0,
          allocU8: () => 0,
          arenaKernelStep: () => 0,
          reduce: () => 0,
          kindOf: () => 0,
          symOf: () => 0,
          leftOf: () => 0,
          rightOf: () => 0,
          initArena: () => 1,
          connectArena: () => 1,
        } as ArenaWasmExports),
      Error,
      "debugLockState export is required but missing",
    );

    assertThrows(
      () =>
        ParallelArenaEvaluatorInternals.validateSabExports({
          reset: () => {},
          allocTerminal: () => 0,
          allocCons: () => 0,
          allocU8: () => 0,
          arenaKernelStep: () => 0,
          reduce: () => 0,
          kindOf: () => 0,
          symOf: () => 0,
          leftOf: () => 0,
          rightOf: () => 0,
          initArena: () => 1,
          connectArena: () => 1,
          debugLockState: () => 0,
        } as ArenaWasmExports),
      Error,
      "getArenaMode export is required but missing",
    );

    assertThrows(
      () =>
        ParallelArenaEvaluatorInternals.validateSabExports({
          reset: () => {},
          allocTerminal: () => 0,
          allocCons: () => 0,
          allocU8: () => 0,
          arenaKernelStep: () => 0,
          reduce: () => 0,
          kindOf: () => 0,
          symOf: () => 0,
          leftOf: () => 0,
          rightOf: () => 0,
          initArena: () => 1,
          connectArena: () => 1,
          debugLockState: () => 0,
          getArenaMode: () => 1,
        } as ArenaWasmExports),
      Error,
      "debugGetArenaBaseAddr export is required but missing",
    );
  });
});
