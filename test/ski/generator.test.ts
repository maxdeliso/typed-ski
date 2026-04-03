import { test } from "node:test";
import { assert } from "../util/assertions.ts";
import rsexport, { type RandomSeed } from "random-seed";
import { randExpression } from "../../lib/ski/generator.ts";
import { terminals } from "../../lib/ski/expression.ts";
const { create } = rsexport;

test("generate", async (t) => {
  const testSeed = "18477814418";
  const n = 8;

  await t.test("generates a random expression with the specified size", () => {
    const rs: RandomSeed = create(testSeed);
    const generated = randExpression(rs, n);

    assert.deepStrictEqual(n, terminals(generated));
  });
});
