import { describe, it } from "../util/test_shim.ts";
import assert from "node:assert/strict";
import rsexport, { type RandomSeed } from "random-seed";
import { randExpression } from "../../lib/ski/generator.ts";
import { terminals } from "../../lib/ski/expression.ts";
const { create } = rsexport;

describe("generate", () => {
  const testSeed = "18477814418";
  const n = 8;

  it("generates a random expression with the specified size", () => {
    const rs: RandomSeed = create(testSeed);
    const generated = randExpression(rs, n);

    assert.deepStrictEqual(n, terminals(generated));
  });
});
