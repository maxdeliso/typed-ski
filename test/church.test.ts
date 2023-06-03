import { parse } from '../lib/parser'
import { stepMany } from '../lib/evaluator'
import { Expression, apply } from '../lib/expression'

import { describe, it } from 'mocha'
import { expect } from 'chai'

/*
 * zero. apply a function to its arguments zero times.
 *
 * λfx.x
 *
 * KIfx
 * Ix (by K)
 * x (by I)
 */
const zero = parse('KI')

/*
 * one. apply a function to its arguments once.
 *
 * λx.x
 *
 * Ifx
 * fx (by I)
 */
const one = parse('I')

/*
 * successor function
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
 * this acts as the successor function for Church numerals
 */
const succ = parse('S(S(SK)K)')

/*
 * composition function
 *
 * λnfx.n(fx)
 *
 * S(KS)Knfx
 * (KS)n(Kn)fx (by S)
 * S(Kn)fx (by K)
 * (Kn)x(fx) (by S)
 * n(fx)
 */
const B = parse('S(KS)K')

describe('Church encodings', () => {
  const reduce = (exp: Expression): Expression =>
    stepMany(exp).expr

  const Church = (n: number): Expression => {
    if (n < 0) {
      throw new Error('only positive integers represented')
    } else if (n === 0) {
      return zero
    } else if (n === 1) {
      return one
    } else {
      return reduce(apply(succ, Church(n - 1)))
    }
  }

  it('reduces 0 + 1 to 1 ', () => {
    expect(one)
      .to.deep.equal(Church(1))
  })

  it('reduces 1 + 1 to 2', () => {
    expect(reduce(apply(succ, one)))
      .to.deep.equal(Church(2))
  })

  it('reduces sums in Church numerals', () => {
    for (let m = 0; m < 8; m++) {
      for (let n = 0; n < 8; n++) {
        const sum = Church(m + n)

        /*
         * λmn.(m succ)n is equivalent to m + n in Church numerals
         */
        expect(reduce(apply(Church(m), succ, Church(n))))
          .to.deep.equal(sum)
      }
    }
  })

  it('reduces products in Church numerals', () => {
    for (let m = 0; m < 8; m++) {
      for (let n = 0; n < 8; n++) {
        const product = Church(m * n)

        /*
         * λmn.m(n(succ)) is equivalent to m * n in Church numerals
         */
        expect(reduce(apply(Church(m), apply(Church(n), succ), zero)))
          .to.deep.equal(product)

        /*
         * Bmnfx yields (m(nf))x which is also equivalent to m * n
         * so the B combinator is functional composition and multiplication
         * in the Church numerals simultaneously.
         */
        expect(reduce(apply(B, Church(m), Church(n), succ, zero)))
          .to.deep.equal(product)
      }
    }
  })
})
