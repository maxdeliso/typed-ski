import { assert } from "npm:chai";
import rsexport, { type RandomSeed } from "npm:random-seed";
const { create } = rsexport;

import { cons } from "../../lib/cons.ts";
import {
  prettyPrint,
  size,
  type SKIExpression,
} from "../../lib/ski/expression.ts";
import { K, S } from "../../lib/ski/terminal.ts";
import { randExpression } from "../../lib/ski/generator.ts";

Deno.test("prettyPrint", async (t) => {
  const expr = cons<SKIExpression>(cons<SKIExpression>(S, K), K);
  const printedExpr = "((SK)K)";

  await t.step("pretty prints a valid expression", () => {
    assert.deepStrictEqual(prettyPrint(expr), printedExpr);
  });
});

Deno.test("generate", async (t) => {
  const testSeed = "18477814418";
  const n = 8;

  await t.step("generates a random expression with the specified size", () => {
    const rs: RandomSeed = create(testSeed);
    const generated = randExpression(rs, n);

    assert.deepStrictEqual(n, size(generated));
  });
});
