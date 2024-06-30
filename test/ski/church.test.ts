import { apply } from '../../lib/ski/expression'
import { S, K, I } from '../../lib/ski/terminal'
import { reduceSKI } from '../../lib/evaluator/skiEvaluator'
import { UnChurch, ChurchN, ChurchB } from '../../lib/ski/church'
import {
  Fst, Snd, Car, Cdr,
  Succ,
  V, B,
  False, Zero, True,
  Plus,
  F,
  pred
} from '../../lib/consts/combinators'

import { describe, it } from 'mocha'
import { expect } from 'chai'
import { parseSKI } from '../../lib/parser/ski'

export const UpTo = (n: number): number[] => {
  const result = []
  for (let i = 0; i < n; i++) {
    result.push(i)
  }
  return result
}

/*
 * This test verifies that numeral systems and boolean logic can be encoded
 * using only combinators. See https://www.youtube.com/watch?v=6BnVo7EHO_8 this
 * talk by Gabriel Lebec for an excellent in-depth explanation.
 */

describe('Church encodings', () => {
  const DupePair = apply(parseSKI('SS(SK)'), V)

  it('reduces 0 + 1 to 1 ', () => {
    expect(UnChurch(apply(Succ, ChurchN(0))))
      .to.deep.equal(1)
  })

  it('reduces 1 + 1 to 2', () => {
    expect(UnChurch(reduceSKI(apply(Succ, ChurchN(1)))))
      .to.deep.equal(2)
  })

  it('reduces boolean expressions in Church encoding', () => {
    [false, true].forEach(p => {
      [false, true].forEach(q => {
        const conj = ChurchB(p && q)

        const dis = ChurchB(p || q)

        /*
         * λpq.pqp is AND
         *
         * (AND)TT = T?T:T = T
         * (AND)TF = T?F:T = F
         * (AND)FT = F?T:F = F
         * (AND)FF = F?F:F = F
         */
        expect(reduceSKI(apply(ChurchB(p), ChurchB(q), ChurchB(p))))
          .to.deep.equal(conj)

        /*
         * λpq.ppq is OR
         *
         * (OR)TT = T?T:T = T
         * (OR)TF = T?T:F = T
         * (OR)FT = F?F:T = T
         * (OR)FF = F?F:F = F
         */
        expect(reduceSKI(apply(ChurchB(p), ChurchB(p), ChurchB(q))))
          .to.deep.equal(dis)
      })
    })
  })

  it('reduces pairs', () => {
    expect(reduceSKI(apply(V, ChurchN(0), ChurchN(1), Fst)))
      .to.deep.equal(ChurchN(0))

    expect(reduceSKI(apply(V, ChurchN(0), ChurchN(1), Snd)))
      .to.deep.equal(ChurchN(1))

    expect(reduceSKI(
      apply(Car, apply(V, ChurchN(0), ChurchN(1)))
    )).to.deep.equal(ChurchN(0))

    expect(reduceSKI(
      apply(Cdr, apply(V, ChurchN(0), ChurchN(1)))
    )).to.deep.equal(ChurchN(1))

    expect(
      reduceSKI(apply(DupePair, ChurchN(2)))
    ).to.deep.equal(reduceSKI(apply(V, ChurchN(2), ChurchN(2))))
  })

  /*
   * F True (KF) n -> n (KF) True
   */
  const IsZero = apply(F, True, apply(K, False))

  it('isZero tests for whether a numeral is zero', () => {
    expect(reduceSKI(
      apply(ChurchN(0), apply(K, False), True)
    )).to.deep.equal(ChurchB(true))

    expect(reduceSKI(
      apply(ChurchN(1), apply(K, False), True)
    )).to.deep.equal(ChurchB(false))

    expect(reduceSKI(
      apply(ChurchN(2), apply(K, False), True)
    )).to.deep.equal(ChurchB(false))

    expect(reduceSKI(
      apply(IsZero, ChurchN(0))
    )).to.deep.equal(ChurchB(true))

    expect(reduceSKI(
      apply(IsZero, ChurchN(1))
    )).to.deep.equal(ChurchB(false))
  })

  it('reduces sums and products in Church numerals', () => {
    UpTo(8).forEach(m => {
      UpTo(8).forEach(n => {
        // λmn.(m succ)n, or apply m +1s to n
        expect(UnChurch(
          reduceSKI(apply(ChurchN(m), Succ, ChurchN(n)))
        )).to.equal(m + n)

        // λmnfx.mf((nf)x) ≡ BS(BB) ≡ Plus
        expect(UnChurch(
          reduceSKI(apply(Plus, ChurchN(m), ChurchN(n)))
        )).to.equal(m + n)

        // λmn.m(n(succ)), or apply m +ns to 0
        expect(UnChurch(
          reduceSKI(apply(ChurchN(m), apply(ChurchN(n), Succ), Zero))
        )).to.equal(m * n)

        /*
         * Bmnfx yields m(nf)x which is also equivalent to m * n
         * so the B combinator is functional composition and multiplication
         * in the Church numerals simultaneously.
         */
        expect(UnChurch(
          reduceSKI(apply(B, ChurchN(m), ChurchN(n), Succ, Zero))
        )).to.equal(m * n)
      })
    })
  })

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
    apply(B, apply(B, I, Car), I))

  const pairZeroZero = apply(V, ChurchN(0), ChurchN(0))

  it('computes the predecessor', () => {
    UpTo(8).forEach(m => {
      const expected = Math.max(m - 1, 0) // pred of 0 is 0

      expect(
        UnChurch(
          reduceSKI(
            apply(Cdr, apply(ChurchN(m), pairShiftSucc, pairZeroZero))
          )
        )
      ).to.equal(expected)

      expect(
        UnChurch(reduceSKI(apply(pred, ChurchN(m))))
      ).to.deep.equal(expected)
    })
  })
})
