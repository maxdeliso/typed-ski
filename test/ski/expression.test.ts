import { test } from "node:test";
import { assert } from "../util/assertions.ts";

import {
  apply,
  equivalent,
  terminals,
  toSKIKey,
  unparseSKI,
} from "../../lib/ski/expression.ts";
import { K, S } from "../../lib/ski/terminal.ts";

const expr = apply(apply(S, K), K);
const otherExpr = apply(K, S);

test("expression functions", async (t) => {
  await t.test("toSKIKey with expr", () => {
    assert.deepStrictEqual(toSKIKey(expr), ["(", "(", "S", "K", ")", "K", ")"]);
  });

  await t.test("toSKIKey with other otherExpr", () => {
    assert.deepStrictEqual(toSKIKey(otherExpr), ["(", "K", "S", ")"]);
  });

  await t.test("equivalent", () => {
    assert.strictEqual(equivalent(expr, expr), true);
    assert.strictEqual(equivalent(expr, otherExpr), false);
    assert.strictEqual(equivalent(otherExpr, expr), false);
    assert.strictEqual(equivalent(otherExpr, otherExpr), true);
  });

  await t.test("unparseSKI", () => {
    assert.deepStrictEqual(unparseSKI(expr), "((SK)K)");
  });

  await t.test("terminals", () => {
    assert.strictEqual(terminals(expr), 3);
  });

  await t.test("apply", () => {
    const applied = apply(expr, otherExpr);
    assert.deepStrictEqual(unparseSKI(applied), "(((SK)K)(KS))");
  });

  await t.test("apply with one expression", () => {
    const applied = apply(expr, expr);
    assert.deepStrictEqual(unparseSKI(applied), "(((SK)K)((SK)K))");
  });
  await t.test("apply with two expressions", () => {
    const applied = apply(expr, otherExpr);
    assert.deepStrictEqual(unparseSKI(applied), "(((SK)K)(KS))");
  });
});
