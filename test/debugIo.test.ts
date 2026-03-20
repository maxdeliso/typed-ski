import { assertEquals } from "std/assert";
import { ParallelArenaEvaluatorWasm } from "../lib/index.ts";
import { I, WriteOne } from "../lib/ski/terminal.ts";
import { apply } from "../lib/ski/expression.ts";

Deno.test("Evaluator - Direct WriteOne", async () => {
  const evaluator = await ParallelArenaEvaluatorWasm.create(1);
  try {
    // Apply WriteOne to byte 65 ('A') and identity callback I
    const expr = apply(apply(WriteOne, { kind: "u8", value: 65 }), I);

    // Reduce it
    const result = await evaluator.reduceAsync(expr);

    // Result should be the U8 node (callback return value)
    assertEquals(result.kind, "u8");
    assertEquals((result as { value: number }).value, 65);

    // Check stdout
    const stdout = await evaluator.readStdout();
    assertEquals(stdout.length, 1);
    assertEquals(stdout[0], 65);
  } finally {
    evaluator.terminate();
  }
});
