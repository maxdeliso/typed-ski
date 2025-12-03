import { assert, assertEquals } from "std/assert";
import { ParallelArenaEvaluatorWasm } from "../../lib/evaluator/parallelArenaEvaluator.ts";
import { parseSKI } from "../../lib/parser/ski.ts";
import { prettyPrint, type SKIExpression } from "../../lib/ski/expression.ts";

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

Deno.test("ParallelArenaEvaluator - basic evaluation still works", async (t) => {
  await t.step(
    "can still evaluate expressions (fallback to parent)",
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
    "evaluates (SII)(SII) in parallel - generates lock contention",
    async () => {
      const evaluator = await ParallelArenaEvaluatorWasm.create(2);
      const { $: exports } = evaluator;
      const expr = parseSKI("(SII)(SII)");

      const baselineAcquisitions = exports.debugGetLockAcquisitionCount?.() ??
        0;
      const baselineReleases = exports.debugGetLockReleaseCount?.() ?? 0;

      const sendWork = (max: number): Promise<SKIExpression> => {
        return evaluator.reduceAsync(expr, max);
      };

      // (SII)(SII) has an infinite reduction sequence - it reduces to itself
      // Run two evaluations in parallel for 1000 steps to generate lock contention
      const promise1 = sendWork(1000);
      const promise2 = sendWork(1000);

      // Wait for both workers to complete their work
      const [result1, result2] = await Promise.all([promise1, promise2]);

      // Get final lock counts
      const totalAcquisitions = exports.debugGetLockAcquisitionCount?.() ??
        0 - baselineAcquisitions;
      const totalReleases = exports.debugGetLockReleaseCount?.() ??
        0 - baselineReleases;

      // Both workers evaluated the same expression for the same number of steps,
      // so they should produce identical results
      assertEquals(
        prettyPrint(result1),
        prettyPrint(result2),
        "Both workers should produce the same result when evaluating the same expression",
      );

      // Validate that locks were acquired and released (proves concurrent access)
      assert(
        totalAcquisitions > 0,
        `Expected lock acquisitions > 0, got ${totalAcquisitions}`,
      );
      assert(
        totalReleases > 0,
        `Expected lock releases > 0, got ${totalReleases}`,
      );

      evaluator.terminate();
    },
  );
});
