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
 *   unparseTypedLambda,
 *   unparseUntypedLambda,
 *   unparseSKI,
 *   typecheckSystemF,
 *   eraseSystemF,
 *   eraseTypedLambda,
 *   bracketLambda,
 *   resolvePoly,
 *   arenaEvaluator,
 *   UnChurchNumber
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
 * const typedLambda = eraseSystemF(mainPoly.term);
 * console.log("2. Typed Lambda:", unparseTypedLambda(typedLambda));
 *
 * const untypedLambda = eraseTypedLambda(typedLambda);
 * console.log("3. Untyped Lambda:", unparseUntypedLambda(untypedLambda));
 *
 * const skiCombinators = bracketLambda(untypedLambda);
 * console.log("4. SKI Combinators:", unparseSKI(skiCombinators));
 *
 * // Evaluation and unchurching
 * const normalForm = arenaEvaluator.reduce(skiCombinators);
 * console.log("5. Normal Form:", unparseSKI(normalForm));
 *
 * const result = UnChurchNumber(normalForm);
 * console.log("6. UnChurch Result:", result); // 1
 * ```
 *
 * @module
 */

import type { TripLangProgram } from "./trip.ts";
import { compile } from "./frontend/compilation.ts";

export { compile };
export type { TripLangProgram };
