import { apply, applyMany } from "../../lib/ski/expression.ts";
import { B, I, K, S } from "../../lib/consts/combinators.ts";
import { parseSKI } from "../../lib/parser/ski.ts";

/**
 * Binary addition
 * λmnfx.mf((nf)x) ≡ BS(BB) ≡ Plus
 */
export const Plus = applyMany(B, S, apply(B, B));

export const Zero = apply(K, I);
export const Snd = Zero;
export const False = Zero;

export const True = K;
export const Fst = True;

/*
 * Thrush (flip)
 * λxy.yx ≡ CI ≡ flip
 */
const C = applyMany(S, applyMany(B, B, S), apply(K, K));
const T = apply(C, I);

/**
 * Retrieve the first element in a Cons cell.
 */
export const Car = apply(T, Fst);

/**
 * Retrieve the second element in a Cons cell.
 */
export const Cdr = apply(T, Snd);

// λabcde.ab(cde)
const E = apply(B, applyMany(B, B, B));

// λabc.cba
export const F = applyMany(E, T, T, E, T);

/**
 * Y combinator (fixed-point)
 */
export const Y = parseSKI("S(K(SII))(S(S(KS)K)(K(SII)))");
