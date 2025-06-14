import { assert } from "npm:chai";
import rsexport, { type RandomSeed } from "npm:random-seed";
import { randExpression } from "../../lib/ski/generator.ts";
import { terminals } from "../../lib/ski/expression.ts";
const { create } = rsexport;

Deno.test("generate", async (t) => {
  const testSeed = "18477814418";
  const n = 8;

  await t.step("generates a random expression with the specified size", () => {
    const rs: RandomSeed = create(testSeed);
    const generated = randExpression(rs, n);

    assert.deepStrictEqual(n, terminals(generated));
  });
});
