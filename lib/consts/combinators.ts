/**
 * Predefined SKI combinator expressions.
 *
 * This module provides predefined SKI combinator expressions including
 * Church numerals, boolean values, and common combinators like B, C, T, etc.
 *
 * @module
 */
import { parseSKI } from "../parser/ski.ts";
import { apply } from "../ski/expression.ts";
import { I, K, S } from "../ski/terminal.ts";

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
export const Zero = apply(K, I);
export const Snd = Zero;

/*
 * false is the second alternative of two arguments
 *
 * false ? a : b = b
 *
 * λab.b ≡ KI ≡ False
 */
export const False = Zero;

/*
 * true is the first alternative of two arguments
 *
 * true ? a : b = a
 *
 * λab.a ≡ K ≡ True
 */
export const True = K;
export const Fst = True;

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
export const One = I;

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
export const B = parseSKI("S(KS)K");

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
export const Succ = apply(S, B);

/*
 * Binary addition
 *
 * λmnfx.mf((nf)x)
 *
 * BS(BB)mnfx
 * S((BB)m)nfx
 * ((BB)m)f(nf)x
 * BBmf(nf)x
 * B(mf)(nf)x
 * (mf)((nf)x)
 *
 * λmnfx.mf((nf)x) ≡ BS(BB) ≡ Plus
 */
export const Plus = apply(B, S, apply(B, B));

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
export const C = apply(S, apply(B, B, S), apply(K, K));

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
export const T = apply(C, I);

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
export const V = apply(B, C, T);

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
export const M = parseSKI("SII");

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
export const Car = apply(T, Fst);

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
export const Cdr = apply(T, Snd);

/*
 * Duplicate the second argument of a function.
 *
 * λxy.xyy
 *
 * SS(SK)xy
 * Sx((SK)x)y
 * xy(((SK)x)y)
 * xy(Ky(Kx))
 * xyy
 *
 * λxy.xyy ≡ W
 */
export const W = parseSKI("SS(SK)");

// λabcd.a(bcd)
export const Blk = apply(B, B, B);

// λabcde.ab(cde)
export const E = apply(B, apply(B, B, B));

// λabc.cba
export const F = apply(E, T, T, E, T);

// λf.(λx.f(x x))(λx.f(x x))
export const Y = parseSKI("S(K(SII))(S(S(KS)K)(K(SII)))");
