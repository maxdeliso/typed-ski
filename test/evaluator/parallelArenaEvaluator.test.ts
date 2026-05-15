import assert from "node:assert/strict";
import { describe, it } from "../util/test_shim.ts";
import { loadWorkspaceFile } from "../util/fileLoader.ts";
import { compileTripAndRun } from "../compiler/llvm/nativeHarness.ts";

const kCombinator = loadWorkspaceFile(
  "test/evaluator/fixtures/k-combinator.trip",
);
const kSmall = loadWorkspaceFile("test/evaluator/fixtures/k-small.trip");
const identity21 = loadWorkspaceFile(
  "test/evaluator/fixtures/identity-21.trip",
);
const kLargeAlt = loadWorkspaceFile("test/evaluator/fixtures/k-large-alt.trip");

describe("Reduction correctness - native LLVM", () => {
  it("K combinator returns its first argument", async () => {
    // Corresponds to: I K → K (K applied to two values gives first)
    const result = await compileTripAndRun(kCombinator);
    assert.equal(result.status, 42);
  });

  it("multiple programs compiled independently produce correct results", async () => {
    // Corresponds to: reduces many expressions correctly with a multi-worker runtime
    // Even indices: K(1, 0) = 1, Odd indices: identity(21) = 21
    const results = await Promise.all([
      compileTripAndRun(kSmall),
      compileTripAndRun(identity21),
      compileTripAndRun(kSmall),
      compileTripAndRun(identity21),
    ]);

    results.forEach((result, i) => {
      assert.equal(result.status, i % 2 === 0 ? 1 : 21);
    });
  });

  it("concurrent independent compilations preserve separate results", async () => {
    // Corresponds to: preserves results across concurrent independent sessions
    const [r1, r2, r3] = await Promise.all([
      compileTripAndRun(kSmall),
      compileTripAndRun(identity21),
      compileTripAndRun(kLargeAlt),
    ]);

    assert.equal(r1.status, 1); // K 1 0 = 1
    assert.equal(r2.status, 21); // id 21 = 21
    assert.equal(r3.status, 42); // K 42 1 = 42
  });
});
