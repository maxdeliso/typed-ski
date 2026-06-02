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
export { I, K, S } from "../ski/terminal.ts";
import { I, K, S } from "../ski/terminal.ts";

/*
 * false is the second alternative of two arguments
 */
export const False = apply(K, I);

export const Zero = False;

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
