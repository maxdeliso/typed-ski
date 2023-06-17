import { parse } from '../lib/parser'
import { stepMany } from '../lib/evaluator'
import { Expression, apply } from '../lib/expression'

import { describe, it } from 'mocha'
import { expect } from 'chai'
import { S, K, I, TerminalSymbol } from '../lib/terminal'

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
const Snd = Zero

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
const Fst = True

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
 * SBnfx
 * Bf(nf)x
 * f((nf)x)
 * f(nfx)
 *
 * λnfx.f(nfx) ≡ S(S(SK)K) ≡ SB ≡ Succ
 *
 * this acts as the successor function for Church numerals
 */
const Succ = apply(S, B)

const Plus = apply(B, S, apply(B, B))

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
    return apply(Succ, ChurchN(n - 1))
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ToFunc = (exp: Expression): any => {
  if (exp.kind === 'non-terminal') {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call
    return ToFunc(exp.lft)(ToFunc(exp.rgt))
  } else {
    switch (exp.sym) {
    // eslint-disable-next-line max-len
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, max-len
      case TerminalSymbol.S: return (x: (arg0: any) => {(arg0: any): any; new(): any }) => (y: (arg0: any) => any) => (z: any) => x(z)((y(z)))
      // eslint-disable-next-line max-len
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars, @typescript-eslint/no-unsafe-return
      case TerminalSymbol.K: return (x: any) => (_y: any) => x
      // eslint-disable-next-line max-len
      // eslint-disable-next-line @typescript-eslint/no-unsafe-return, @typescript-eslint/no-explicit-any
      case TerminalSymbol.I: return (x: any) => x
    }
  }
}

/*
 * To verify that combinator expressions produce n applications of f on x,
 * this function is introduced which runs the combinator forward with a lambda
 * that adds one to its argument and returns a number.
 *
 * This is needed because each function has infinitely many representations
 * in the SKI combinators, but we are concerned with whether a given function
 * represents a Church numeral, regardless of which one it is.
 */
const UnChurch = (exp: Expression): number => {
  // eslint-disable-next-line max-len
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call
  return ToFunc(exp)((x: number) => x + 1)(0)
}

const ChurchB = (b: boolean): Expression => b ? True : False

/*
 * Cardinal
 *
 * or flip once removed
 *
 * λxyz.xzy
 *
 * S(BBS)(KK)xyz
 * (BBS)x((KK)x)yz
 * ((BB)S)xKyz
 * Sx(Ky)z
 * xz((Ky)z)
 * xzy
 *
 * λxyz.xzy ≡ S(BBS)(KK)
 */
const C = apply(S, apply(B, B, S), apply(K, K))

/*
 * Thrush
 *
 * or flip
 *
 * λxy.yx
 *
 * CIxy
 * Iyx
 * yx
 *
 * λxy.yx ≡ CI ≡ flip
 */
const T = apply(C, I)

/*
 * Vireo
 *
 * or Pair
 *
 * λabf.fab
 *
 * BCTabf
 * C(Ta)bf
 * (Ta)fb
 * fab
 *
 * λabf.fab ≡ BCT ≡ Pair
 *
 * Pair a b = <a, b>, a 2-tuple waiting for a function.
 *
 * Sometimes called a cons cell.
 */
const V = apply(B, C, T)

/*
 * Mockingbird
 *
 * λa.aa
 *
 * SIIx
 * Ix(Ix)
 * x(Ix)
 * xx
 *
 * λa.aa ≡ M
 */
// const M = parse('SII')

/*
 * Retrieve the first element in a Cons cell.
 *
 * Car p
 *
 * p = <a,b>
 *
 * T Fst p
 * p Fst
 * p K
 * a
 */
const Car = apply(T, Fst)

/*
 * Retrieve the second element in a Cons cell.
 *
 * Cdr p
 *
 * p = <a,b>
 *
 * T Snd p
 * p Snd
 * p KI
 * b
 */
const Cdr = apply(T, Snd)

const DownFrom = (n: number): Array<number> => {
  const result = []
  for (let i = n; i >= 0; i--) {
    result.push(i)
  }
  return result
}

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

  it('is zero', () => {
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

  it('reduces sums and products in Church numerals', () => {
    DownFrom(8).forEach(m => {
      DownFrom(8).forEach(n => {
        // λmn.(m succ)n is equivalent to m + n in Church numerals
        expect(UnChurch(
          reduce(apply(ChurchN(m), Succ, ChurchN(n)))
        )).to.equal(m + n)

        expect(UnChurch(
          reduce(apply(Plus, ChurchN(m), ChurchN(n)))
        )).to.equal(m + n)

        //  λmn.m(n(succ)) is equivalent to m * n in Church numerals
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
