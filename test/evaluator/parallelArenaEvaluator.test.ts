import { test } from "node:test";
import assert from "node:assert/strict";
import randomSeed from "random-seed";
import type { ArenaWasmExports } from "../../lib/evaluator/arenaEvaluator.ts";
import { ParallelArenaEvaluatorWasm } from "../../lib/evaluator/parallelArenaEvaluator.ts";
import { parseSKI } from "../../lib/parser/ski.ts";
import { unparseSKI } from "../../lib/ski/expression.ts";

function bytes(values: number[]): ArrayBuffer {
  return new Uint8Array(values).buffer;
}

const mockWasm = {
  allocCons: () => 1,
  allocTerminal: () => 1,
  allocU8: () => 1,
  arenaKernelStep: () => 1,
  connectArena: () => 1,
  debugCalculateArenaSize: () => 1,
  debugGetArenaBaseAddr: () => 1,
  debugGetRingEntries: () => 1,
  debugLockState: () => 0,
  getArenaMode: () => 1,
} as unknown as ArenaWasmExports;

test("ParallelArenaEvaluator - basic reduction", async () => {
  const evaluator = await ParallelArenaEvaluatorWasm.create(2);
  try {
    const expr = parseSKI("I K");
    const result = await evaluator.reduceAsync(expr);
    assert.strictEqual(unparseSKI(result), "K");
  } finally {
    evaluator.terminate();
  }
});

test("ParallelArenaEvaluator - many concurrent reductions", async () => {
  const evaluator = await ParallelArenaEvaluatorWasm.create(4);
  try {
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => {
        const expr = parseSKI(i % 2 === 0 ? "I K" : "I S");
        return evaluator.reduceAsync(expr);
      }),
    );
    results.forEach((res, i) => {
      assert.strictEqual(unparseSKI(res), i % 2 === 0 ? "K" : "S");
    });
  } finally {
    evaluator.terminate();
  }
});

test("ParallelArenaEvaluator - concurrent mixed work", async (t) => {
  const evaluator = await ParallelArenaEvaluatorWasm.create(2);
  try {
    const promises = [
      evaluator.reduceAsync(parseSKI("I K")),
      evaluator.reduceAsync(parseSKI("I S")),
      evaluator.reduceAsync(parseSKI("K S I")),
    ];
    const results = await Promise.all(promises);
    assert.strictEqual(unparseSKI(results[0]!), "K");
    assert.strictEqual(unparseSKI(results[1]!), "S");
    assert.strictEqual(unparseSKI(results[2]!), "S");
  } finally {
    evaluator.terminate();
  }
});
