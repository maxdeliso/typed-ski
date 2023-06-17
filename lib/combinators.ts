import { apply } from './expression'
import { parse } from './parser'
import { S, K, I } from './terminal'

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
export const Zero = apply(K, I)
export const Snd = Zero

/*
 * false is the second alternative of two arguments
 *
 * false ? a : b = b
 *
 * λab.b ≡ KI ≡ False
 */
export const False = Zero

/*
 * true is the first alternative of two arguments
 *
 * true ? a : b = a
 *
 * λab.a ≡ K ≡ True
 */
export const True = K
export const Fst = True

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
export const One = I

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
export const B = parse('S(KS)K')

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
export const Succ = apply(S, B)

export const Plus = apply(B, S, apply(B, B))

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
export const V = apply(B, C, T)

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
export const M = parse('SII')

/*
 * Retrieve the first element in a Cons cell.
 *
 * Car p
 *
 * p = <a, b>
 *
 * T Fst p
 * p Fst
 * p K
 * a
 */
export const Car = apply(T, Fst)

/*
 * Retrieve the second element in a Cons cell.
 *
 * Cdr p
 *
 * p = <a, b>
 *
 * T Snd p
 * p Snd
 * p KI
 * b
 */
export const Cdr = apply(T, Snd)
