import { strict as assert } from 'assert';
import { ChurchN, UnChurchBoolean } from '../../lib/ski/church.js';
import { S, K, I } from '../../lib/ski/terminal.js';
import { apply } from '../../lib/ski/expression.js';
import { mkNativeNum, mkNativeInc, stepOnceNat, reduceNat, unChurchNumber, NativeExpr } from '../../lib/ski/native.js';
import { cons } from '../../lib/cons.js';
import { Zero, One, True, False } from '../../lib/consts/combinators.js';

describe('Native Expression Tests', () => {
  describe('Basic Native Expression Construction', () => {
    it('constructs a number expression', () => {
      const n = mkNativeNum(42);
      assert.equal(n.kind, 'num');
      assert.equal(n.value, 42);
    });

    it('constructs an increment expression', () => {
      const inc = mkNativeInc();
      assert.equal(inc.kind, 'inc');
    });

    it('constructs an application expression', () => {
      const app = cons(mkNativeNum(1) as NativeExpr, mkNativeNum(2) as NativeExpr);
      assert.equal(app.kind, 'non-terminal');
      assert.equal(app.lft.kind, 'num');
      assert.equal(app.lft.value, 1);
      assert.equal(app.rgt.kind, 'num');
      assert.equal(app.rgt.value, 2);
    });
  });

  describe('Native Step Reduction', () => {
    it('reduces (INC (NUM k)) to NUM (k+1)', () => {
      const expr = cons(mkNativeInc() as NativeExpr, mkNativeNum(5) as NativeExpr);
      const result = stepOnceNat(expr);
      assert.ok(result.altered);
      assert.equal(result.expr.kind, 'num');
      assert.equal(result.expr.value, 6);
    });

    it('does not reduce non-matching expressions', () => {
      const expr = cons(mkNativeNum(1) as NativeExpr, mkNativeNum(2) as NativeExpr);
      const result = stepOnceNat(expr);
      assert.ok(!result.altered);
      assert.equal(result.expr, expr);
    });

    it('handles nested applications', () => {
      const expr = cons(cons(mkNativeInc() as NativeExpr, mkNativeNum(1) as NativeExpr) as NativeExpr, mkNativeNum(2) as NativeExpr);
      const result = stepOnceNat(expr);
      assert.ok(result.altered);
      assert.equal(result.expr.kind, 'non-terminal');
      assert.equal(result.expr.lft.kind, 'num');
      assert.equal(result.expr.lft.value, 2);
      assert.equal(result.expr.rgt.kind, 'num');
      assert.equal(result.expr.rgt.value, 2);
    });
  });

  describe('Native Reduction', () => {
    it('reduces to normal form', () => {
      const expr = cons(cons(mkNativeInc() as NativeExpr, mkNativeNum(1) as NativeExpr) as NativeExpr, mkNativeNum(2) as NativeExpr);
      const result = reduceNat(expr);
      assert.equal(result.kind, 'non-terminal');
      assert.equal(result.lft.kind, 'num');
      assert.equal(result.lft.value, 2);
      assert.equal(result.rgt.kind, 'num');
      assert.equal(result.rgt.value, 2);
    });

    it('handles multiple steps', () => {
      // (INC (INC (NUM 0))) -> (INC (NUM 1)) -> NUM 2
      const expr = cons(mkNativeInc() as NativeExpr, cons(mkNativeInc() as NativeExpr, mkNativeNum(0) as NativeExpr) as NativeExpr);
      const result = reduceNat(expr);
      assert.equal(result.kind, 'num');
      assert.equal(result.value, 2);
    });
  });

  describe('Church Numeral Decoding', () => {
    it('decodes Church zero', () => {
      const zero = ChurchN(0);
      assert.equal(unChurchNumber(zero), 0);
    });

    it('decodes Church one', () => {
      const one = ChurchN(1);
      assert.equal(unChurchNumber(one), 1);
    });

    it('decodes Church two', () => {
      const two = ChurchN(2);
      assert.equal(unChurchNumber(two), 2);
    });

    it('decodes Church five', () => {
      const five = ChurchN(5);
      assert.equal(unChurchNumber(five), 5);
    });

    it('handles larger Church numerals', () => {
      const ten = ChurchN(10);
      assert.equal(unChurchNumber(ten), 10);
    });

    it('returns 0 on non-normal form', () => {
      const nonNumeral = apply(K, I);
      assert.equal(unChurchNumber(nonNumeral), 0);
    });

    it('handles complex Church numeral expressions', () => {
      const malformed = apply(S, K, I);
      assert.equal(unChurchNumber(malformed), 1);
    });

    describe('Combinator Church Numeral Decoding', () => {
      it('decodes Zero combinator to 0', () => {
        assert.equal(unChurchNumber(Zero), 0);
      });

      it('decodes One combinator to 1', () => {
        assert.equal(unChurchNumber(One), 1);
      });

      it('decodes True combinator as true (as Church boolean)', () => {
        assert.equal(UnChurchBoolean(True), true);
      });

      it('decodes False combinator as false (as Church boolean)', () => {
        assert.equal(UnChurchBoolean(False), false);
      });
    });
  });
});
