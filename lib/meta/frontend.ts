/**
 * This module provides the frontend compilation interface for TripLang programs.
 * It exports the main compile function and TripLangProgram type for compiling
 * TripLang source code into executable programs.
 *
 * @example
 * ```ts
 * import {
 *   compile,
 *   type TripLangProgram,
 *   unparseSystemF,
 *   unparseSystemFType,
 *   unparseSKI,
 *   typecheckSystemF,
 *   eraseSystemF,
 *   bracketLambda,
 *   resolvePoly,
 * } from "jsr:@maxdeliso/typed-ski";
 *
 * const tripLangCode = `
 * module MyModule
 * type Nat = #X -> (X -> X) -> X -> X
 * poly zero = #X => \s : X -> X => \z : X => z
 * poly succ = \n : Nat => #a => \s : a -> a => \z : a => s (n [a] s z)
 * poly one = succ zero
 * poly main = one
 * `;
 *
 * const program: TripLangProgram = compile(tripLangCode);
 * const mainPoly = resolvePoly(program, "main");
 *
 * // Full compilation pipeline
 * console.log("1. System F:", unparseSystemF(mainPoly.term));
 * console.log("   Type:", unparseSystemFType(typecheckSystemF(mainPoly.term)));
 *
 * const untypedLambda = eraseSystemF(mainPoly.term);
 * const skiCombinators = bracketLambda(untypedLambda);
 * console.log("2. SKI Combinators:", unparseSKI(skiCombinators));
 *
 * console.log("3. SKI Result:", unparseSKI(skiCombinators));
 * ```
 *
 * @module
 */

import type { TripLangProgram } from "./trip.ts";
import { compile } from "./frontend/compilation.ts";

export { compile };
export type { TripLangProgram };
