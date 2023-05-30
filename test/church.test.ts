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
 * as an algebraic function this is
 *
 * successor n = n + 1
 */
const succ = parse('S(S(SK)K)')

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

  it('reduces a + b to its sum in Church numerals', () => {
    /*
     * λab.a succ b
     *
     * in other words, apply the first church numeral to the successor function,
     * and then apply the result to the second church numeral, which yields
     * a + b
     */
    for (let a = 0; a < 8; a++) {
      for (let b = 0; b < 8; b++) {
        expect(reduce(apply(apply(Church(a), succ), Church(b))))
          .to.deep.equal(Church(a + b))
      }
    }
  })

  it('reduces a * b to its product in Church numerals', () => {
    /*
     * λab.(a(b succ))0
     * is equivalent to (+ b) a times on 0
     */
    for (let a = 0; a < 8; a++) {
      for (let b = 0; b < 8; b++) {
        expect(reduce(apply(apply(Church(a), apply(Church(b), succ)), zero)))
          .to.deep.equal(Church(a * b))
      }
    }
  })
})
