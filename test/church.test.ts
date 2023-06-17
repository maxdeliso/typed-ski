import { apply } from '../lib/expression'
import { K } from '../lib/terminal'
import { reduce } from '../lib/evaluator'
import { UnChurch, ChurchN, ChurchB } from '../lib/church'
import {
  Fst, Snd, Car, Cdr,
  Succ,
  V, B,
  False, Zero, True,
  Plus
} from '../lib/combinators'

import { describe, it } from 'mocha'
import { expect } from 'chai'

/*
 * This test verifies that numeral systems and boolean logic can be encoded
 * using only combinators. See https://www.youtube.com/watch?v=6BnVo7EHO_8 this
 * talk by Gabriel Lebec for an excellent in-depth explanation.
 */

describe('Church encodings', () => {
  it('reduces 0 + 1 to 1 ', () => {
    expect(UnChurch(apply(Succ, ChurchN(0))))
      .to.deep.equal(1)
  })

  it('reduces 1 + 1 to 2', () => {
    expect(UnChurch(reduce(apply(Succ, ChurchN(1)))))
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
        expect(reduce(apply(ChurchB(p), ChurchB(q), ChurchB(p))))
          .to.deep.equal(conj)

        /*
         * λpq.ppq is OR
         *
         * (OR)TT = T?T:T = T
         * (OR)TF = T?T:F = T
         * (OR)FT = F?F:T = T
         * (OR)FF = F?F:F = F
         */
        expect(reduce(apply(ChurchB(p), ChurchB(p), ChurchB(q))))
          .to.deep.equal(dis)
      })
    })
  })

  it('reduces pairs', () => {
    expect(reduce(apply(V, ChurchN(0), ChurchN(1), Fst)))
      .to.deep.equal(ChurchN(0))

    expect(reduce(apply(V, ChurchN(0), ChurchN(1), Snd)))
      .to.deep.equal(ChurchN(1))

    expect(
      reduce(
        apply(Car, apply(V, ChurchN(0), ChurchN(1)))
      )).to.deep.equal(ChurchN(0))

    expect(
      reduce(
        apply(Cdr, apply(V, ChurchN(0), ChurchN(1)))
      )).to.deep.equal(ChurchN(1))
  })

  it('isZero tests for whether a numeral is zero', () => {
    expect(
      reduce(
        apply(ChurchN(0), apply(K, False), True)
      )).to.deep.equal(ChurchB(true))

    expect(
      reduce(
        apply(ChurchN(1), apply(K, False), True)
      )).to.deep.equal(ChurchB(false))

    expect(
      reduce(
        apply(ChurchN(2), apply(K, False), True)
      )
    ).to.deep.equal(ChurchB(false))
  })

  const UpTo = (n: number): Array<number> => {
    const result = []
    for (let i = 0; i < n; i++) {
      result.push(i)
    }
    return result
  }

  it('reduces sums and products in Church numerals', () => {
    UpTo(8).forEach(m => {
      UpTo(8).forEach(n => {
        // λmn.(m succ)n is equivalent to m + n in Church numerals
        expect(UnChurch(
          reduce(apply(ChurchN(m), Succ, ChurchN(n)))
        )).to.equal(m + n)

        expect(UnChurch(
          reduce(apply(Plus, ChurchN(m), ChurchN(n)))
        )).to.equal(m + n)

        // λmn.m(n(succ)) is equivalent to m * n in Church numerals
        expect(UnChurch(
          reduce(apply(ChurchN(m), apply(ChurchN(n), Succ), Zero))
        )).to.equal(m * n)

        /*
         * Bmnfx yields m(nf)x which is also equivalent to m * n
         * so the B combinator is functional composition and multiplication
         * in the Church numerals simultaneously.
         */
        expect(UnChurch(
          reduce(apply(B, ChurchN(m), ChurchN(n), Succ, Zero))
        )).to.equal(m * n)
      })
    })
  })
})
