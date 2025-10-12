import { assert } from "chai";

import {
  apply,
  equivalent,
  prettyPrint,
  terminals,
  toSKIKey,
} from "../../lib/ski/expression.ts";
import { K, S } from "../../lib/ski/terminal.ts";

const expr = apply(apply(S, K), K);
const otherExpr = apply(K, S);

Deno.test("expression functions", async (t) => {
  await t.step("toSKIKey with expr", () => {
    assert.deepStrictEqual(
      toSKIKey(expr),
      ["(", "(", "S", "K", ")", "K", ")"],
    );
  });

  await t.step("toSKIKey with other otherExpr", () => {
    assert.deepStrictEqual(
      toSKIKey(otherExpr),
      ["(", "K", "S", ")"],
    );
  });

  await t.step("equivalent", () => {
    assert.strictEqual(equivalent(expr, expr), true);
    assert.strictEqual(equivalent(expr, otherExpr), false);
    assert.strictEqual(equivalent(otherExpr, expr), false);
    assert.strictEqual(equivalent(otherExpr, otherExpr), true);
  });

  await t.step("prettyPrint", () => {
    assert.deepStrictEqual(prettyPrint(expr), "((SK)K)");
  });

  await t.step("terminals", () => {
    assert.strictEqual(terminals(expr), 3);
  });

  await t.step("apply", () => {
    const applied = apply(expr, otherExpr);
    assert.deepStrictEqual(prettyPrint(applied), "(((SK)K)(KS))");
  });

  await t.step("apply with one expression", () => {
    const applied = apply(expr, expr);
    assert.deepStrictEqual(prettyPrint(applied), "(((SK)K)((SK)K))");
  });
  await t.step("apply with two expressions", () => {
    const applied = apply(expr, otherExpr);
    assert.deepStrictEqual(prettyPrint(applied), "(((SK)K)(KS))");
  });
});
