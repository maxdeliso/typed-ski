import { test } from "node:test";
import assert from "node:assert/strict";
import { ParallelArenaEvaluatorWasm } from "../lib/index.ts";
import { I, WriteOne } from "../lib/ski/terminal.ts";
import { apply } from "../lib/ski/expression.ts";

test("Evaluator - Direct WriteOne", async () => {
  const evaluator = await ParallelArenaEvaluatorWasm.create(1);
  try {
    // Apply WriteOne to byte 65 ('A') and identity callback I
    const expr = apply(apply(WriteOne, { kind: "u8", value: 65 }), I);

    // Reduce it
    const result = await evaluator.reduceAsync(expr);

    // Result should be the U8 node (callback return value)
    assert.deepStrictEqual(result.kind, "u8");
    assert.deepStrictEqual((result as { value: number }).value, 65);

    // Check stdout
    const stdout = await evaluator.readStdout();
    assert.deepStrictEqual(stdout.length, 1);
    assert.deepStrictEqual(stdout[0], 65);
  } finally {
    evaluator.terminate();
  }
});
