import { assert } from "npm:chai";

import { ChurchN, UnChurchBoolean } from "../../lib/ski/church.ts";
import { I, K, S } from "../../lib/ski/terminal.ts";
import { apply } from "../../lib/ski/expression.ts";

import {
  mkNativeInc,
  mkNativeNum,
  type NativeExpr,
  reduceNat,
  stepOnceNat,
  unChurchNumber,
} from "../../lib/ski/native.ts";

import { cons } from "../../lib/cons.ts";
import { False, One, True, Zero } from "../../lib/consts/combinators.ts";

function assertIsNum(
  e: NativeExpr,
): asserts e is { kind: "num"; value: number } {
  assert.equal(e.kind, "num", "expected kind 'num'");
}

function assertIsNonTerm(
  e: NativeExpr,
): asserts e is { kind: "non-terminal"; lft: NativeExpr; rgt: NativeExpr } {
  assert.equal(e.kind, "non-terminal", "expected kind 'non-terminal'");
}

Deno.test("Native-expression & Church-numeral utilities", async (t) => {
  await t.step("basic construction helpers", async (t) => {
    await t.step("mkNativeNum", () => {
      const n = mkNativeNum(42);
      assert.equal(n.kind, "num");
      assert.equal(n.value, 42);
    });

    await t.step("mkNativeInc", () => {
      const inc = mkNativeInc();
      assert.equal(inc.kind, "inc");
    });

    await t.step("non-terminal application node", () => {
      const app = cons(
        mkNativeNum(1) as NativeExpr,
        mkNativeNum(2) as NativeExpr,
      );
      assertIsNonTerm(app);
      assertIsNum(app.lft);
      assert.equal(app.lft.value, 1);
      assertIsNum(app.rgt);
      assert.equal(app.rgt.value, 2);
    });
  });

  await t.step("single-step reduction (stepOnceNat)", async (t) => {
    await t.step("(INC (NUM k)) → NUM (k+1)", () => {
      const expr = cons(
        mkNativeInc() as NativeExpr,
        mkNativeNum(5) as NativeExpr,
      );
      const { altered, expr: out } = stepOnceNat(expr);
      assert.ok(altered);
      assertIsNum(out);
      assert.equal(out.value, 6);
    });

    await t.step("no reduction when pattern doesn’t match", () => {
      const expr = cons(
        mkNativeNum(1) as NativeExpr,
        mkNativeNum(2) as NativeExpr,
      );
      const r = stepOnceNat(expr);
      assert.ok(!r.altered);
      assert.equal(r.expr, expr);
    });

    await t.step("nested applications reduce inner-most first", () => {
      const expr = cons(
        cons(
          mkNativeInc() as NativeExpr,
          mkNativeNum(1) as NativeExpr,
        ) as NativeExpr,
        mkNativeNum(2) as NativeExpr,
      );
      const r = stepOnceNat(expr);
      assert.ok(r.altered);
      assertIsNonTerm(r.expr);
      assertIsNum(r.expr.lft);
      assert.equal(r.expr.lft.value, 2);
      assertIsNum(r.expr.rgt);
      assert.equal(r.expr.rgt.value, 2);
    });
  });

  await t.step("full reduction (reduceNat)", async (t) => {
    await t.step("reduces to normal form", () => {
      const expr = cons(
        cons(
          mkNativeInc() as NativeExpr,
          mkNativeNum(1) as NativeExpr,
        ) as NativeExpr,
        mkNativeNum(2) as NativeExpr,
      );
      const out = reduceNat(expr);
      assertIsNonTerm(out);
      assertIsNum(out.lft);
      assert.equal(out.lft.value, 2);
      assertIsNum(out.rgt);
      assert.equal(out.rgt.value, 2);
    });

    await t.step("multiple incremental steps", () => {
      // (INC (INC 0)) → (INC 1) → 2
      const expr = cons(
        mkNativeInc() as NativeExpr,
        cons(
          mkNativeInc() as NativeExpr,
          mkNativeNum(0) as NativeExpr,
        ) as NativeExpr,
      );
      const out = reduceNat(expr);
      assertIsNum(out);
      assert.equal(out.value, 2);
    });
  });

  await t.step("decoding Church numerals", async (t) => {
    for (const n of [0, 1, 2, 5, 10]) {
      await t.step(`Church ${n} decodes to ${n}`, () => {
        assert.equal(unChurchNumber(ChurchN(n)), n);
      });
    }

    await t.step("non-numeral normalises to 0", () => {
      assert.equal(unChurchNumber(apply(K, I)), 0);
    });

    await t.step("malformed numeral gives 1", () => {
      assert.equal(unChurchNumber(apply(S, K, I)), 1);
    });

    await t.step("combinator constants", async (t) => {
      await t.step("Zero → 0", () => assert.equal(unChurchNumber(Zero), 0));
      await t.step("One  → 1", () => assert.equal(unChurchNumber(One), 1));
      await t.step(
        "True → true",
        () => assert.equal(UnChurchBoolean(True), true),
      );
      await t.step(
        "False → false",
        () => assert.equal(UnChurchBoolean(False), false),
      );
    });
  });
});
