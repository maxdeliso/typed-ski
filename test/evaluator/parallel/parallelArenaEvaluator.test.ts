import { describe, it } from "../../util/test_shim.ts";
import assert from "node:assert/strict";
import { ParallelArenaEvaluatorWasm } from "../../../lib/index.ts";
import { parseSKI } from "../../../lib/parser/ski.ts";

it("ParallelArenaEvaluatorWasm - reduceArenaNodeIdAsync retries on full queue (rc=1)", async () => {
  const evaluator = await ParallelArenaEvaluatorWasm.create(1);
  try {
    const expr = parseSKI("I");
    const nodeId = evaluator.toArena(expr);

    // Mock hostSubmit to return 1 (full) then 0 (ok)
    let submits = 0;
    const originalSubmit = evaluator.$.hostSubmit!;
    const mockedExports = { ...evaluator.$ };
    mockedExports.hostSubmit = (n, r, m) => {
      submits++;
      if (submits === 1) return 1;
      return originalSubmit.call(evaluator.$, n, r, m);
    };
    Object.defineProperty(evaluator, "$", { value: mockedExports });

    // We also need to mock hostPullV2 to return the result
    const originalPull = evaluator.$.hostPullV2!;
    let pulledCount = 0;
    evaluator.$.hostPullV2 = () => {
      if (submits >= 2 && pulledCount === 0) {
        pulledCount++;
        return originalPull.call(evaluator.$);
      }
      return originalPull.call(evaluator.$);
    };

    const result = await evaluator.reduceArenaNodeIdAsync(nodeId, expr);
    assert.strictEqual(submits >= 2, true);
    assert.strictEqual(result, nodeId); // I reduces to I
  } finally {
    evaluator.terminate();
  }
});

it("ParallelArenaEvaluatorWasm - reduceArenaNodeIdAsync throws on rc=2", async () => {
  const evaluator = await ParallelArenaEvaluatorWasm.create(1);
  try {
    const expr = parseSKI("I");
    const nodeId = evaluator.toArena(expr);

    const mockedExports = { ...evaluator.$ };
    mockedExports.hostSubmit = () => 2; // Not connected
    Object.defineProperty(evaluator, "$", { value: mockedExports });

    await assert.rejects(() => evaluator.reduceArenaNodeIdAsync(nodeId, expr), {
      name: "Error",
      message: "hostSubmit failed with code 2",
    });
  } finally {
    evaluator.terminate();
  }
});

it("ParallelArenaEvaluatorWasm - throws if terminated", async () => {
  const evaluator = await ParallelArenaEvaluatorWasm.create(1);
  evaluator.terminate();
  const expr = parseSKI("I");
  await assert.rejects(() => evaluator.reduceAsync(expr), {
    name: "Error",
    message: "Evaluator terminated",
  });
});

it("ParallelArenaEvaluatorWasm - reduceArenaNodeIdAsync uses macrotask backoff after prolonged full queue", async () => {
  const evaluator = await ParallelArenaEvaluatorWasm.create(1);
  try {
    const expr = parseSKI("I");
    const nodeId = evaluator.toArena(expr);

    let submits = 0;
    const originalSubmit = evaluator.$.hostSubmit!;
    const mockedExports = { ...evaluator.$ };
    mockedExports.hostSubmit = (n, r, m) => {
      submits++;
      if (submits <= 512) return 1;
      return originalSubmit.call(evaluator.$, n, r, m);
    };
    Object.defineProperty(evaluator, "$", { value: mockedExports });

    const result = await evaluator.reduceArenaNodeIdAsync(nodeId, expr);
    assert.strictEqual(result, nodeId);
    assert.strictEqual(submits > 512, true);
  } finally {
    evaluator.terminate();
  }
});

it("ParallelArenaEvaluatorWasm - reduceArenaNodeIdAsync wraps non-Error submit failures", async () => {
  const evaluator = await ParallelArenaEvaluatorWasm.create(1);
  try {
    const expr = parseSKI("I");
    const nodeId = evaluator.toArena(expr);

    const mockedExports = { ...evaluator.$ };
    mockedExports.hostSubmit = () => {
      throw "string failure";
    };
    Object.defineProperty(evaluator, "$", { value: mockedExports });

    await assert.rejects(
      () => evaluator.reduceArenaNodeIdAsync(nodeId, expr),
      (err) => {
        return err instanceof Error && err.message === "string failure";
      },
    );
  } finally {
    evaluator.terminate();
  }
});
