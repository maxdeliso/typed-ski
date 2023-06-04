import { parse } from '../lib/parser'
import { stepMany } from '../lib/evaluator'
import { Expression, apply } from '../lib/expression'

import { describe, it } from 'mocha'
import { expect } from 'chai'

/*
 * This test verifies that numeral systems and boolean logic can be encoded
 * using only combinators. See https://www.youtube.com/watch?v=6BnVo7EHO_8 this
 * talk by Gabriel Lebec for an excellent in-depth explanation.
 */

/*
 * Zero. apply a function to its arguments zero times.
 *
 * λfx.x
 *
 * KIfx
 * Ix (by K)
 * x (by I)
 *
 * λfx.x ≡ KI
 */
const Zero = parse('KI')

/*
 * false is the second alternative of two arguments
 *
 * false ? a : b = b
 *
 * λab.b ≡ KI ≡ False
 */
const False = Zero

/*
 * true is the first alternative of two arguments
 *
 * true ? a : b = a
 *
 * λab.a ≡ K ≡ True
 */
const True = parse('K')

/*
 * One. apply a function to its arguments once.
 *
 * λx.x
 *
 * Ifx
 * fx (by I)
 *
 * λx.x ≡ I
 */
const One = parse('I')

/*
 * Composition function
 *
 * λnfx.n(fx)
 *
 * S(KS)Knfx
 * (KS)n(Kn)fx (by S)
 * S(Kn)fx (by K)
 * (Kn)x(fx) (by S)
 * n(fx)
 *
 * λnfx.n(fx) ≡ B
 */
const B = parse('S(KS)K')

/*
 * Successor function
 *
 * λnfx.f(nfx)
 *
 * S(S(KS)K)nfx
 * S(KS)Kf(nf)x (by S)
 * (KS)f(Kf)(nf)x (by S)
 * S(Kf)(nf)x (by K)
 * (Kf)x(nfx) (by K)
 * f(nfx)
 *
 * λnfx.f(nfx) ≡ S(S(SK)K) ≡ Succ
 *
 * this acts as the successor function for Church numerals
 */
const Succ = parse('S(S(SK)K)')

describe('Church encodings', () => {
  const reduce = (exp: Expression): Expression =>
    stepMany(exp).expr

  const ChurchN = (n: number): Expression => {
    if (n < 0) {
      throw new Error('only positive integers represented')
    } else if (n === 0) {
      return Zero
    } else if (n === 1) {
      return One
    } else {
      return reduce(apply(Succ, ChurchN(n - 1)))
    }
  }

  const ChurchB = (b: boolean): Expression => b ? True : False

  const UpTo = (n: number): Array<number> => {
    const result = []
    for (let i = n; i >= 0; i--) {
      result.push(i)
    }
    return result
  }

  it('reduces 0 + 1 to 1 ', () => {
    expect(One)
      .to.deep.equal(ChurchN(1))
  })

  it('reduces 1 + 1 to 2', () => {
    expect(reduce(apply(Succ, One)))
      .to.deep.equal(ChurchN(2))
  })

  it('reduces sums and products in Church numerals', () => {
    UpTo(8).forEach(m => {
      UpTo(8).forEach(n => {
        const sum = ChurchN(m + n)

        const product = ChurchN(m * n)

        /*
         * λmn.(m succ)n is equivalent to m + n in Church numerals
         */
        expect(reduce(apply(ChurchN(m), Succ, ChurchN(n))))
          .to.deep.equal(sum)

        /*
         * λmn.m(n(succ)) is equivalent to m * n in Church numerals
         */
        expect(reduce(apply(ChurchN(m), apply(ChurchN(n), Succ), Zero)))
          .to.deep.equal(product)

        /*
         * Bmnfx yields m(nf)x which is also equivalent to m * n
         * so the B combinator is functional composition and multiplication
         * in the Church numerals simultaneously.
         */
        expect(reduce(apply(B, ChurchN(m), ChurchN(n), Succ, Zero)))
          .to.deep.equal(product)
      })
    })
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
})
