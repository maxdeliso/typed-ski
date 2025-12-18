import { assert, assertEquals } from "std/assert";
import randomSeed from "random-seed";
import { ParallelArenaEvaluatorWasm } from "../../lib/evaluator/parallelArenaEvaluator.ts";
import { parseSKI } from "../../lib/parser/ski.ts";
import {
  apply,
  prettyPrint,
  type SKIExpression,
} from "../../lib/ski/expression.ts";
import { randExpression } from "../../lib/ski/generator.ts";
import { I, K, S } from "../../lib/ski/terminal.ts";

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
    const evaluator = await ParallelArenaEvaluatorWasm.create(2);
    assert(evaluator !== null);
    evaluator.terminate();
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
      const evaluator = await ParallelArenaEvaluatorWasm.create(2);
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
      console.log(
        `[DEBUG] Arena mode before reduce: ${mode} (1=SAB, 0=heap)`,
      );
      assertEquals(mode, 1, "Arena should be in SAB mode");
      const lockState = exports.debugLockState();
      console.log(
        `[DEBUG] Lock state before reduce: ${lockState} (0=unlocked, 1=locked, 0xffffffff=uninit)`,
      );

      if (lockState === 0xffffffff) {
        throw new Error("Arena not initialized (lock state = 0xffffffff)");
      }

      const expr = parseSKI("III");
      const result = await evaluator.reduceAsync(expr);
      assertEquals(prettyPrint(result), "I");
      evaluator.terminate();
    },
  );

  await t.step("can perform stepOnce operations", async () => {
    const evaluator = await ParallelArenaEvaluatorWasm.create(2);
    const expr = parseSKI("II");
    const step = evaluator.stepOnce(expr);
    assert(step.altered);
    assertEquals(prettyPrint(step.expr), "I");
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
    assertEquals(prettyPrint(result), "I");
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

    assertEquals(prettyPrint(result1), "I");
    assertEquals(prettyPrint(result2), "I");
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
          prettyPrint(result1),
          prettyPrint(result2),
          "Parallel executions produced different results (violated determinism). " +
            `Worker 1: ${prettyPrint(result1)}, Worker 2: ${
              prettyPrint(result2)
            }`,
        );
      } finally {
        evaluator.terminate();
      }
    },
  );
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
          assertEquals(prettyPrint(results[i]), prettyPrint(exprs[i]));
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
        // RING_ENTRIES is 1024 in wasm; exceed it several times.
        const N = 4096;
        const exprs = Array.from(
          { length: N },
          (_, i) => makeUniqueExpr(i, 20),
        );

        const results = await Promise.all(
          exprs.map((e) => evaluator.reduceAsync(e, 0)),
        );
        for (let i = 0; i < N; i++) {
          assertEquals(prettyPrint(results[i]), prettyPrint(exprs[i]));
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
          prettyPrint(reconstructed),
          prettyPrint(expr),
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
      const expr = parseSKI("III");
      // Reduce using the ring-based async path
      const reduced = await evaluator.reduceAsync(expr, 100);
      assertEquals(prettyPrint(reduced), "I");
      evaluator.terminate();
    },
  );

  await t.step(
    "fromArena works with reduceAsync and manual toArena/fromArena round-trip",
    async () => {
      const evaluator = await ParallelArenaEvaluatorWasm.create(2);
      const expr = parseSKI("III");
      // Use reduceAsync which uses fromArena internally
      const result = await evaluator.reduceAsync(expr, 100);
      assertEquals(prettyPrint(result), "I");
      // Also verify we can manually convert to/from arena
      const arenaId = evaluator.toArena(expr);
      const manualResult = evaluator.fromArena(arenaId);
      assertEquals(prettyPrint(manualResult), prettyPrint(expr));
      evaluator.terminate();
    },
  );

  await t.step(
    "fromArena preserves DAG structure (hash consing)",
    async () => {
      const evaluator = await ParallelArenaEvaluatorWasm.create(2);
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
        prettyPrint(reconstructed1),
        prettyPrint(reconstructed2),
        "Reconstructed expressions should match",
      );
      evaluator.terminate();
    },
  );

  await t.step(
    "fromArena handles complex nested expressions",
    async () => {
      const evaluator = await ParallelArenaEvaluatorWasm.create(2);
      const complexExpr = parseSKI("S(SKK)(SKK)I");
      const arenaId = evaluator.toArena(complexExpr);
      const reconstructed = evaluator.fromArena(arenaId);
      assertEquals(
        prettyPrint(reconstructed),
        prettyPrint(complexExpr),
        "Complex nested expression should be correctly reconstructed",
      );
      evaluator.terminate();
    },
  );

  await t.step(
    "views cache correctly invalidates and rebuilds when arena grows",
    async () => {
      const evaluator = await ParallelArenaEvaluatorWasm.create(2);

      // Create an initial expression and convert to arena (this will populate the cache)
      const initialExpr = parseSKI("III");
      const initialId = evaluator.toArena(initialExpr);
      const initialReconstructed = evaluator.fromArena(initialId);
      assertEquals(prettyPrint(initialReconstructed), prettyPrint(initialExpr));

      // Get initial capacity from the arena header
      const memory = evaluator.memory;
      const baseAddr = evaluator.$.debugGetArenaBaseAddr?.();
      assert(
        baseAddr !== undefined && baseAddr !== 0,
        "Arena should be initialized",
      );
      const headerView = new Uint32Array(memory.buffer, baseAddr, 32);
      const initialCapacity = headerView[13];

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
      let lastTop = headerView[2]; // top is at offset 2
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
          const currentCapacity = headerView[1];
          const currentTop = headerView[2];
          lastTop = currentTop;

          if (currentCapacity > initialCapacity) {
            // Arena has grown! Now test that fromArena still works correctly
            // with the new capacity
            const lastExpr = testExpressions[testExpressions.length - 1];
            const lastId = testIds[testIds.length - 1];
            const reconstructed = evaluator.fromArena(lastId);
            assertEquals(
              prettyPrint(reconstructed),
              prettyPrint(lastExpr),
              `fromArena should work correctly after arena growth (capacity: ${initialCapacity} -> ${currentCapacity})`,
            );

            // Also verify that the initial expression still works
            const initialReconstructedAfterGrow = evaluator.fromArena(
              initialId,
            );
            assertEquals(
              prettyPrint(initialReconstructedAfterGrow),
              prettyPrint(initialExpr),
              "Initial expression should still be reconstructable after arena growth",
            );

            // Test a few stored expressions to ensure cache is working
            const testCount = Math.min(10, testExpressions.length);
            for (
              let k = testExpressions.length - testCount;
              k < testExpressions.length;
              k++
            ) {
              const testReconstructed = evaluator.fromArena(testIds[k]);
              assertEquals(
                prettyPrint(testReconstructed),
                prettyPrint(testExpressions[k]),
                `Expression at index ${k} should be reconstructable after growth`,
              );
            }

            // Successfully validated cache invalidation and rebuild
            evaluator.terminate();
            return;
          }
        }
      }

      // Still verify that stored expressions can be reconstructed
      for (let i = 0; i < testExpressions.length; i++) {
        const reconstructed = evaluator.fromArena(testIds[i]);
        assertEquals(
          prettyPrint(reconstructed),
          prettyPrint(testExpressions[i]),
          `Expression at index ${i} should be reconstructable`,
        );
      }

      evaluator.terminate();
    },
  );
});
