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
 *   prettyPrintSystemF,
 *   prettyPrintSystemFType,
 *   prettyPrintTypedLambda,
 *   prettyPrintUntypedLambda,
 *   prettyPrintSKI,
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
 * type Nat = ∀X . (X → X) → X → X
 * poly zero = ΛX . λs : X → X . λz : X . z
 * poly succ = λn : Nat . Λa . λs : a → a . λz : a . s (n [a] s z)
 * poly one = succ zero
 * poly main = one
 * `;
 *
 * const program: TripLangProgram = compile(tripLangCode);
 * const mainPoly = resolvePoly(program, "main");
 *
 * // Full compilation pipeline
 * console.log("1. System F:", prettyPrintSystemF(mainPoly.term));
 * console.log("   Type:", prettyPrintSystemFType(typecheckSystemF(mainPoly.term)));
 *
 * const typedLambda = eraseSystemF(mainPoly.term);
 * console.log("2. Typed Lambda:", prettyPrintTypedLambda(typedLambda));
 *
 * const untypedLambda = eraseTypedLambda(typedLambda);
 * console.log("3. Untyped Lambda:", prettyPrintUntypedLambda(untypedLambda));
 *
 * const skiCombinators = bracketLambda(untypedLambda);
 * console.log("4. SKI Combinators:", prettyPrintSKI(skiCombinators));
 *
 * // Evaluation and unchurching
 * const normalForm = arenaEvaluator.reduce(skiCombinators);
 * console.log("5. Normal Form:", prettyPrintSKI(normalForm));
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
