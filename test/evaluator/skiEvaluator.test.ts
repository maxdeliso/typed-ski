import assert from "node:assert/strict";
import { describe, it } from "../util/test_shim.ts";
import { loadWorkspaceFile } from "../util/fileLoader.ts";
import { compileTripAndRun } from "../compiler/llvm/nativeHarness.ts";

const identity = loadWorkspaceFile("test/evaluator/fixtures/identity.trip");
const kCombinator = loadWorkspaceFile(
  "test/evaluator/fixtures/k-combinator.trip",
);
const bLawComposition = loadWorkspaceFile(
  "test/evaluator/fixtures/b-law-composition.trip",
);
const bLawOrder = loadWorkspaceFile("test/evaluator/fixtures/b-law-order.trip");
const cLawFlip = loadWorkspaceFile("test/evaluator/fixtures/c-law-flip.trip");
const cLawFlipDistinct = loadWorkspaceFile(
  "test/evaluator/fixtures/c-law-flip-distinct.trip",
);

describe("Function identity - native LLVM", () => {
  it("identity function passes through a value", async () => {
    // Corresponds to: I x = x
    const result = await compileTripAndRun(identity);
    assert.equal(result.status, 42);
  });
});

describe("Combinator laws - native LLVM", () => {
  it("constant function returns its first argument (K combinator)", async () => {
    // Corresponds to: K x y = x
    const result = await compileTripAndRun(kCombinator);
    assert.equal(result.status, 42);
  });

  it("B law: outer applied to result of inner (f (g x))", async () => {
    // Corresponds to: B f g x = f (g x)
    // outer(inner(10)) = add3(add4(10)) = add3(14) = 17
    const result = await compileTripAndRun(bLawComposition);
    assert.equal(result.status, 17); // 3 + (4 + 10) = 17
  });

  it("B law: application order is preserved for non-commutative functions", async () => {
    // outer(inner(3)) = sub10(sub5(3)) = sub10(2) = 8
    // inner(outer(3)) would be sub5(sub10(3)) = sub5(7) = ... 2 (different)
    const result = await compileTripAndRun(bLawOrder);
    assert.equal(result.status, 8); // 10 - (5 - 3) = 8
  });

  it("C law: flip wrapper swaps argument order", async () => {
    // Corresponds to: C f x y = f y x
    // flip_sub 3 10 = subU8 10 3 = 7  (not subU8 3 10 = 249)
    const result = await compileTripAndRun(cLawFlip);
    assert.equal(result.status, 7); // sub 10 3 = 7
  });

  it("C law: distinct arguments produce distinct results when swapped", async () => {
    // flip_sub 10 20 = subU8 20 10 = 10
    const result = await compileTripAndRun(cLawFlipDistinct);
    assert.equal(result.status, 10); // sub 20 10 = 10
  });
});
