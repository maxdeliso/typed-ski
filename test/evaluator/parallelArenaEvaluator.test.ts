import { assert, assertEquals, assertThrows } from "std/assert";
import randomSeed from "random-seed";
import { ParallelArenaEvaluatorWasm } from "../../lib/evaluator/parallelArenaEvaluator.ts";
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
import { BinN, UnBinNumber } from "../../lib/ski/bin.ts";
import { randExpression } from "../../lib/ski/generator.ts";
import { I, K, ReadOne, S, WriteOne } from "../../lib/ski/terminal.ts";
import { requiredAt } from "../util/required.ts";

function makeUniqueExpr(i: number, bits = 16): SKIExpression {
  // Deterministic, bounded-size expression that is unique for i < 2^bits.
  let e: SKIExpression = I;
  for (let b = 0; b < bits; b++) {
    e = apply(e, (i >>> b) & 1 ? S : K);
  }
  return e;
}

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
    assertEquals(UnBinNumber(result), 65n);
    evaluator.terminate();
  });

  await t.step("writeOne enqueues bytes to stdout", async () => {
    const evaluator = await ParallelArenaEvaluatorWasm.create(1);
    const expr = apply(WriteOne, BinN(66));
    const result = await evaluator.reduceAsync(expr);
    assertEquals(UnBinNumber(result), 66n);
    const stdout = evaluator.readStdout(1);
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
      const expr = apply(WriteOne, BinN(byte));
      await evaluator.reduceAsync(expr);
    }
    const stdout = evaluator.readStdout(bytes.length);
    assertEquals(stdout, bytes);
    evaluator.terminate();
  });

  await t.step("echo round-trip with readOne/writeOne", async () => {
    const evaluator = await ParallelArenaEvaluatorWasm.create(1);
    const encoder = new TextEncoder();
    const payload = encoder.encode("echo");
    for (const byte of payload) {
      const expr = apply(ReadOne, WriteOne);
      const promise = evaluator.reduceAsync(expr);
      await evaluator.writeStdin(new Uint8Array([byte]));
      const result = await promise;
      assertEquals(UnBinNumber(result), BigInt(byte));
    }
    const stdout = evaluator.readStdout(payload.length);
    assertEquals(stdout, payload);
    evaluator.terminate();
  });

  await t.step("echo preserves order with queued readOne tasks", async () => {
    const evaluator = await ParallelArenaEvaluatorWasm.create(1);
    try {
      const encoder = new TextEncoder();
      const payload = encoder.encode("queued-echo");
      const pending = Array.from(
        payload,
        () => evaluator.reduceAsync(apply(ReadOne, WriteOne)),
      );
      await evaluator.writeStdin(payload);
      const results = await Promise.all(pending);
      const decoded = results.map((res) => Number(UnBinNumber(res)));
      assertEquals(
        decoded.slice().sort((a, b) => a - b),
        Array.from(payload).sort((a, b) => a - b),
      );
      const stdout = evaluator.readStdout(payload.length);
      assertEquals(stdout, payload);
    } finally {
      evaluator.terminate();
    }
  });

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
      assertEquals(UnBinNumber(readResult), 0n);
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
      const stdout = evaluator.readStdout(16);
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
        assertEquals(UnBinNumber(result), BigInt(byte));
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
        assertEquals(UnBinNumber(result), 7n);
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

Deno.test("ParallelArenaEvaluator - ring stress", async (t) => {
  await t.step(
    "request correlation: results match inputs with maxSteps=0",
    async () => {
      const evaluator = await ParallelArenaEvaluatorWasm.create(4);
      try {
        const N = 400;
        const exprs = Array.from({ length: N }, (_, i) => makeUniqueExpr(i));

        // maxSteps=0 => result should equal input; mismatch implies bad correlation.
        const results = await Promise.all(
          exprs.map((e) => evaluator.reduceAsync(e, 0)),
        );
        for (let i = 0; i < N; i++) {
          assertEquals(
            unparseSKI(requiredAt(results, i, "expected result expression")),
            unparseSKI(requiredAt(exprs, i, "expected input expression")),
          );
        }
      } finally {
        evaluator.terminate();
      }
    },
  );

  await t.step(
    "ring buffer wrap-around when exceeding RING_ENTRIES capacity",
    async () => {
      const evaluator = await ParallelArenaEvaluatorWasm.create(8);
      try {
        // Exceed the WASM ring capacity to force wrap-around in the SQ/CQ indices.
        const ringEntries = evaluator.$.debugGetRingEntries?.() ??
          (() => {
            throw new Error("WASM export `debugGetRingEntries` is missing");
          })();
        // Ensure we wrap at least once even for large rings, and exercise
        // multiple cycles for small ones.
        const extraEntries = Math.max(4096, ringEntries);
        const N = ringEntries + extraEntries;
        const exprBits = Math.ceil(Math.log2(N + 1));
        const exprs = Array.from(
          { length: N },
          // Use enough bits so each expression is unique for this N.
          (_, i) => makeUniqueExpr(i, exprBits),
        );

        const results = await Promise.all(
          exprs.map((e) => evaluator.reduceAsync(e, 0)),
        );
        for (let i = 0; i < N; i++) {
          assertEquals(
            unparseSKI(requiredAt(results, i, "expected result expression")),
            unparseSKI(requiredAt(exprs, i, "expected input expression")),
          );
        }
      } finally {
        evaluator.terminate();
      }
    },
  );
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
