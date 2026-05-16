import assert from "node:assert/strict";
import { describe, it } from "../util/test_shim.ts";
import { loadWorkspaceFile } from "../util/fileLoader.ts";
import { compileTripAndRun } from "../compiler/llvm/nativeHarness.ts";

const kZero = loadWorkspaceFile("test/evaluator/fixtures/k-zero.trip");
const writeA = loadWorkspaceFile("test/evaluator/fixtures/write-a.trip");
const arithmetic = loadWorkspaceFile("test/evaluator/fixtures/arithmetic.trip");

describe("Basic native evaluation", () => {
  it("reduces a basic expression (K combinator)", async () => {
    // Corresponds to: I K → K, then K applied to concrete values
    const result = await compileTripAndRun(kZero);
    assert.equal(result.status, 42);
  });

  it("captures stdout from writeOne", async () => {
    // Corresponds to: WriteOne applied to 65 writes 'A' to stdout
    const result = await compileTripAndRun(writeA);
    assert.equal(result.status, 65);
    assert.equal(result.stdout, "A"); // ASCII 65 is 'A'
  });

  it("arithmetic computation produces the correct result", async () => {
    const result = await compileTripAndRun(arithmetic);
    assert.equal(result.status, 42);
  });
});
