import assert from "node:assert/strict";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "./test_shim.ts";
import { evaluateTrip, evaluateTripWithIo } from "./tripHarness.ts";
import { UnChurchNumber } from "../../lib/ski/church.ts";
import { loadInput } from "./fileLoader.ts";
import { ParallelArenaEvaluatorWasm } from "../../lib/index.ts";
import { parseSKI } from "../../lib/parser/ski.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const linkerTestDir = fileURLToPath(
  new URL("../linker/", import.meta.url).href,
);

describe("TripHarness", () => {
  it("includeNat flag allows using Nat module", async () => {
    const evaluator = await ParallelArenaEvaluatorWasm.create(1);
    try {
      const source = loadInput("includeNat.trip", __dirname);

      const result = await evaluateTrip(source, evaluator, {
        includeNat: true,
        includeBin: true,
      });
      const number = await UnChurchNumber(result, evaluator);

      assert.strictEqual(number, 2n);
    } finally {
      evaluator.terminate();
    }
  });
});

it("TripHarness evaluateTripWithIo reuses provided parallel evaluator", async () => {
  const source = loadInput("echoOne.trip", linkerTestDir);
  const evaluator = await ParallelArenaEvaluatorWasm.create(1);

  try {
    const input = new Uint8Array([65]);
    const { result, stdout } = await evaluateTripWithIo(source, evaluator, {
      stdin: input,
      stdoutMaxBytes: 1,
    });

    assert.equal(stdout.length, 1);
    assert.equal(stdout[0], 65);
    assert.equal((result as { value: number }).value, 65);

    const reused = (await evaluator.reduceAsync(parseSKI("I"))) as any;
    assert.equal(reused.kind, "terminal");
    if (reused.kind !== "terminal") {
      throw new Error(`expected terminal result, got ${reused.kind}`);
    }
    assert.equal(reused.sym, "I");
  } finally {
    evaluator.terminate();
  }
});
