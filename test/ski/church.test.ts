import { describe, it } from 'mocha';
import { expect } from 'chai';

import { V, Succ, Fst, Snd, Car, Cdr, F, True, False, Plus, Zero, B } from '../../lib/consts/combinators.js';
import { symbolicEvaluator } from '../../lib/evaluator/skiEvaluator.js';
import { UnChurchNumber, ChurchN, ChurchB, UnChurchBoolean } from '../../lib/ski/church.js';
import { S, K, I } from '../../lib/ski/terminal.js';
import { bracketLambda } from '../../lib/conversion/converter.js';
import { predLambda } from '../../lib/consts/lambdas.js';
import { apply } from '../../lib/ski/expression.js';

/*
 * This test verifies that numeral systems and boolean logic can be encoded
 * using only combinators. See https://www.youtube.com/watch?v=6BnVo7EHO_8 this
 * talk by Gabriel Lebec for an excellent in-depth explanation.
 */

describe('Church encodings', () => {
  const N = 5;

  it('reduces 0 + 1 to 1 ', () => {
    expect(UnChurchNumber(apply(Succ, ChurchN(0))))
      .to.deep.equal(1);
  });

  it('reduces 1 + 1 to 2', () => {
    expect(UnChurchNumber(symbolicEvaluator.reduce(apply(Succ, ChurchN(1)))))
      .to.deep.equal(2);
  });

  it('reduces boolean expressions in Church encoding', () => {
    [false, true].forEach(p => {
      [false, true].forEach(q => {
        const conj = p && q;

        const dis = p || q;

        /*
         * λpq.pqp is AND
         *
         * (AND)TT = T?T:T = T
         * (AND)TF = T?F:T = F
         * (AND)FT = F?T:F = F
         * (AND)FF = F?F:F = F
         */
        expect(UnChurchBoolean(symbolicEvaluator.reduce(apply(ChurchB(p), ChurchB(q), ChurchB(p)))))
          .to.deep.equal(conj);

        /*
         * λpq.ppq is OR
         *
         * (OR)TT = T?T:T = T
         * (OR)TF = T?T:F = T
         * (OR)FT = F?F:T = T
         * (OR)FF = F?F:F = F
         */
        expect(UnChurchBoolean(symbolicEvaluator.reduce(apply(ChurchB(p), ChurchB(p), ChurchB(q)))))
          .to.deep.equal(dis);
      });
    });
  });

  it('reduces pairs', () => {
    expect(UnChurchNumber(symbolicEvaluator.reduce(apply(V, ChurchN(0), ChurchN(1), Fst))))
      .to.equal(0);

    expect(UnChurchNumber(symbolicEvaluator.reduce(apply(V, ChurchN(0), ChurchN(1), Snd))))
      .to.equal(1);

    expect(UnChurchNumber(symbolicEvaluator.reduce(
      apply(Car, apply(V, ChurchN(0), ChurchN(1)))
    ))).to.equal(0);

    expect(UnChurchNumber(symbolicEvaluator.reduce(
      apply(Cdr, apply(V, ChurchN(0), ChurchN(1)))
    ))).to.equal(1);
  });

  /*
   * F True (KF) n -> n (KF) True
   */
  const IsZero = apply(F, True, apply(K, False));

  it('isZero tests for whether a numeral is zero', () => {
    expect(UnChurchBoolean(symbolicEvaluator.reduce(
      apply(ChurchN(0), apply(K, False), True)
    ))).to.equal(true);

    expect(UnChurchBoolean(symbolicEvaluator.reduce(
      apply(ChurchN(1), apply(K, False), True)
    ))).to.equal(false);

    expect(UnChurchBoolean(symbolicEvaluator.reduce(
      apply(ChurchN(2), apply(K, False), True)
    ))).to.equal(false);

    expect(UnChurchBoolean(symbolicEvaluator.reduce(
      apply(IsZero, ChurchN(0))
    ))).to.equal(true);

    expect(UnChurchBoolean(symbolicEvaluator.reduce(
      apply(IsZero, ChurchN(1))
    ))).to.equal(false);
  });

  it('reduces sums and products in Church numerals', () => {
    // Test all combinations of numbers from 0 to N-1
    for (let m = 0; m < N; m++) {
      for (let n = 0; n < N; n++) {
        // λmn.(m succ)n, or apply m +1s to n
        expect(UnChurchNumber(
          symbolicEvaluator.reduce(apply(ChurchN(m), Succ, ChurchN(n)))
        )).to.equal(m + n);

        // λmnfx.mf((nf)x) ≡ BS(BB) ≡ Plus
        expect(UnChurchNumber(
          symbolicEvaluator.reduce(apply(Plus, ChurchN(m), ChurchN(n)))
        )).to.equal(m + n);

        // λmn.m(n(succ)), or apply m +ns to 0
        expect(UnChurchNumber(
          symbolicEvaluator.reduce(apply(ChurchN(m), apply(ChurchN(n), Succ), Zero))
        )).to.equal(m * n);

        /*
         * Bmnfx yields m(nf)x which is also equivalent to m * n
         * so the B combinator is functional composition and multiplication
         * in the Church numerals simultaneously.
         */
        expect(UnChurchNumber(
          symbolicEvaluator.reduce(apply(B, ChurchN(m), ChurchN(n), Succ, Zero))
        )).to.equal(m * n);
      }
    }
  });

  /*
   * λp.< Succ (Car p), Car p >
   * where <a, b> is the pair constructor, V
   *
   * λ<m, n>.<m+1, m> ≡ S((B(BVN))(B(BIR)I))(B(BIR)I)
   * where Succ is N
   * where Car is R
   */
  const pairShiftSucc = apply(S,
    apply(
      apply(B, apply(B, V, Succ)),
      apply(B, apply(B, I, Car), I)
    ),
    apply(B, apply(B, I, Car), I));

  const pairZeroZero = apply(V, ChurchN(0), ChurchN(0));

  it('computes the predecessor', () => {
    const pred = bracketLambda(predLambda);

    // Test numbers from 0 to N-1
    for (let m = 0; m < N; m++) {
      const expected = Math.max(m - 1, 0); // pred of 0 is 0

      expect(
        UnChurchNumber(
          symbolicEvaluator.reduce(
            apply(Cdr, apply(ChurchN(m), pairShiftSucc, pairZeroZero))
          )
        )
      ).to.equal(expected);

      expect(
        UnChurchNumber(symbolicEvaluator.reduce(apply(pred, ChurchN(m))))
      ).to.deep.equal(expected);
    }
  });
});
