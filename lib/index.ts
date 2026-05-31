/**
 * Typed SKI: SKI calculus and TripLang compiler.
 *
 * This package contains three conceptually distinct things, exposed here
 * through a small public API:
 *
 * 1. **SKI calculus** — parser, printer, Church encoding, bracket abstraction.
 * 2. **System F + typed lambda** — parser, printer, type inference, erasure.
 * 3. **TripLang compiler** — frontend `compile`, LLVM emit, module providers.
 * Library internals (MiniCore IR, Bundle-v1 serialization, legacy SKI-linker
 * helpers, topoDagWire protocol, frontend implementation modules) are not
 * part of the public API. They are importable from their specific module
 * paths but may change without a major version bump.
 *
 * @example
 * ```ts
 * import {
 *   compile,
 *   resolvePoly,
 *   unparseSystemF,
 *   eraseSystemF,
 *   bracketLambda,
 *   unparseSKI,
 *   UnChurchNumber,
 * } from "jsr:@maxdeliso/typed-ski";
 *
 * const program = compile(`
 *   module M
 *   poly main = (\\x : Nat => x) zero
 * `);
 * const mainPoly = resolvePoly(program, "M.main");
 * const ski = bracketLambda(eraseSystemF(mainPoly.term));
 * console.log(unparseSKI(ski));
 * ```
 *
 * @module
 */

// ─── TripLang compiler frontend ────────────────────────────────────────
export { compile } from "./meta/frontend.ts";
export { resolvePoly } from "./meta/frontend/compilation.ts";
export type {
  DataDefinition,
  PolyDefinition,
  TripLangProgram,
  TripLangTerm,
  TypeDefinition,
} from "./meta/trip.ts";

// ─── TripLang LLVM backend (single entry for source → native IR) ────────
export { compileTripSourceToLlvm } from "./compiler/llvmCompiler.ts";

// ─── TripLang source tools ──────────────────────────────────────────────
export {
  discoverTripFiles,
  formatTripSource,
  lintTripSource,
  type TripFormatResult,
  type TripLintDiagnostic,
  type TripLintFix,
  type TripLintResult,
} from "./improvize/index.ts";

// ─── Built-in module providers ─────────────────────────────────────────
export { getAvlObject } from "./avl.ts";
export { getBinObject } from "./bin.ts";
export { getNatObject } from "./nat.ts";
export { getPreludeObject } from "./prelude.ts";

// ─── SKI calculus ───────────────────────────────────────────────────────
export { type SKIExpression, unparseSKI } from "./ski/expression.ts";
export { parseSKI } from "./parser/ski.ts";
export {
  I,
  K,
  ReadOne,
  S,
  type SKITerminal,
  type SKITerminalSymbol,
  WriteOne,
} from "./ski/terminal.ts";
export { ChurchN, UnChurchNumber } from "./ski/church.ts";
export {
  randExpression,
  type RandomSource,
  randTerminal,
} from "./ski/generator.ts";
export { bracketLambda } from "./conversion/converter.ts";

// ─── System F ───────────────────────────────────────────────────────────
export { type SystemFTerm } from "./terms/systemF.ts";
export { parseSystemF, unparseSystemF } from "./parser/systemFTerm.ts";
export { unparseSystemFType } from "./parser/systemFType.ts";
export {
  emptySystemFContext,
  eraseSystemF,
  typecheck as typecheckSystemF,
} from "./types/systemF.ts";

// ─── Type utilities ─────────────────────────────────────────────────────
export { unparseType } from "./parser/type.ts";
export { inferType } from "./types/inference.ts";

// ─── Constants ──────────────────────────────────────────────────────────
export { TEST_TIMEOUT_MS } from "./constants.ts";
