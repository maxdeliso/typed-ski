import assert from "node:assert/strict";
import { expect } from "./assertions.ts";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { evaluateTrip, evaluateTripWithIo } from "./tripHarness.ts";
import { UnChurchNumber } from "../../lib/ski/church.ts";
import { loadInput } from "./fileLoader.ts";
import { ParallelArenaEvaluatorWasm } from "../../lib/index.ts";
import { parseSKI } from "../../lib/parser/ski.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const linkerTestDir = fileURLToPath(
  new URL("../linker/", import.meta.url).href,
);

test("TripHarness", async (t) => {
  await t.test("includeNat flag allows using Nat module", async () => {
    const source = loadInput("includeNat.trip", __dirname);

    const result = await evaluateTrip(source, {
      includeNat: true,
      includeBin: true,
    });
    const number = await UnChurchNumber(result);

    expect(number).to.equal(2n);
  });
});

test("TripHarness evaluateTripWithIo reuses provided parallel evaluator", async () => {
  const source = loadInput("echoOne.trip", linkerTestDir);
  const evaluator = await ParallelArenaEvaluatorWasm.create(1);

  try {
    const input = new Uint8Array([65]);
    const { result, stdout } = await evaluateTripWithIo(source, {
      stdin: input,
      stdoutMaxBytes: 1,
      evaluator,
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

test("TripHarness evaluateTripWithIo auto-created evaluator is terminated after use", async () => {
  const source = loadInput("literalMain.trip", linkerTestDir);
  const { result, stdout, evaluator } = await evaluateTripWithIo(source, {
    stdin: new Uint8Array(),
    stdoutMaxBytes: 1,
  });

  assert.equal(await UnChurchNumber(result), 13n);
  assert.equal(stdout.length, 0);

  await assert.rejects(
    () => (evaluator as ParallelArenaEvaluatorWasm).reduceAsync!(parseSKI("I")),
    { message: "Evaluator terminated" },
  );
});
