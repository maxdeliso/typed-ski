import { assert } from "npm:chai";

import { cons } from "../../lib/cons.ts";
import {
  equivalent,
  prettyPrint,
  type SKIExpression,
  terminals,
  toSKIKey,
} from "../../lib/ski/expression.ts";
import { K, S } from "../../lib/ski/terminal.ts";

const expr = cons<SKIExpression>(cons<SKIExpression>(S, K), K);
const otherExpr = cons<SKIExpression>(K, S);

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
    const applied = cons<SKIExpression>(expr, otherExpr);
    assert.deepStrictEqual(prettyPrint(applied), "(((SK)K)(KS))");
  });

  await t.step("apply with one expression", () => {
    const applied = cons<SKIExpression>(expr, expr);
    assert.deepStrictEqual(prettyPrint(applied), "(((SK)K)((SK)K))");
  });
  await t.step("apply with two expressions", () => {
    const applied = cons<SKIExpression>(expr, otherExpr);
    assert.deepStrictEqual(prettyPrint(applied), "(((SK)K)(KS))");
  });
});
