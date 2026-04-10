import { describe, it } from "../util/test_shim.ts";
import assert from "node:assert/strict";

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

describe("expression functions", () => {
  it("toSKIKey with expr", () => {
    assert.deepStrictEqual(toSKIKey(expr), ["(", "(", "S", "K", ")", "K", ")"]);
  });

  it("toSKIKey with other otherExpr", () => {
    assert.deepStrictEqual(toSKIKey(otherExpr), ["(", "K", "S", ")"]);
  });

  it("equivalent", () => {
    assert.strictEqual(equivalent(expr, expr), true);
    assert.strictEqual(equivalent(expr, otherExpr), false);
    assert.strictEqual(equivalent(otherExpr, expr), false);
    assert.strictEqual(equivalent(otherExpr, otherExpr), true);
  });

  it("unparseSKI", () => {
    assert.deepStrictEqual(unparseSKI(expr), "((SK)K)");
  });

  it("terminals", () => {
    assert.strictEqual(terminals(expr), 3);
  });

  it("apply", () => {
    const applied = apply(expr, otherExpr);
    assert.deepStrictEqual(unparseSKI(applied), "(((SK)K)(KS))");
  });

  it("apply with one expression", () => {
    const applied = apply(expr, expr);
    assert.deepStrictEqual(unparseSKI(applied), "(((SK)K)((SK)K))");
  });
  it("apply with two expressions", () => {
    const applied = apply(expr, otherExpr);
    assert.deepStrictEqual(unparseSKI(applied), "(((SK)K)(KS))");
  });
});
