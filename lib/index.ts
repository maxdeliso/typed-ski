/**
 * Typed SKI: parsing, pretty-printing, evaluation, typing, and TripLang compiler.
 *
 * This module re-exports the public API:
 * - SKI parsing/printing/types and the symbolic evaluator
 * - Untyped/typed lambda and System F term utilities
 * - Type utilities (pretty printing, inference)
 * - TripLang parsing and full compile pipeline (parse → index → elaborate → resolve → typecheck)
 *
 * @example
 * ```ts
 * import { parseSKI, symbolicEvaluator } from "jsr:@maxdeliso/typed-ski";
 * const expr = parseSKI("(K S) I");
 * const nf = symbolicEvaluator.reduce(expr);
 * ```
 *
 * @module
 */
// Core evaluator exports
export { symbolicEvaluator } from "./evaluator/skiEvaluator.ts";

// SKI expression exports
export {
  prettyPrint as prettyPrintSKI,
  type SKIExpression,
} from "./ski/expression.ts";

// Parser exports
export { parseSKI } from "./parser/ski.ts";
export { parseLambda } from "./parser/untyped.ts";
export { parseSystemF } from "./parser/systemFTerm.ts";
export { parseTypedLambda } from "./parser/typedLambda.ts";

// Lambda terms exports
export {
  prettyPrintUntypedLambda,
  type UntypedLambda,
} from "./terms/lambda.ts";

// System F exports
export { prettyPrintSystemF, type SystemFTerm } from "./terms/systemF.ts";

// Typed Lambda exports
export {
  eraseTypedLambda,
  prettyPrintTypedLambda,
  typecheckTypedLambda as typecheckTyped,
  type TypedLambda,
} from "./types/typedLambda.ts";

// System F type exports
export {
  emptySystemFContext,
  eraseSystemF,
  prettyPrintSystemFType,
  typecheck as typecheckSystemF,
} from "./types/systemF.ts";

// Conversion exports
export { bracketLambda } from "./conversion/converter.ts";

// Type system exports
export { prettyPrintTy } from "./types/types.ts";
export { inferType } from "./types/inference.ts";

// TripLang compiler exports
export { parseTripLang } from "./parser/tripLang.ts";
export { compile } from "./meta/frontend.ts";
export {
  type PolyDefinition,
  type TripLangProgram,
  type TripLangTerm,
  type TypedDefinition,
  type TypeDefinition,
} from "./meta/trip.ts";
export { externalReferences } from "./meta/frontend/externalReferences.ts";
export {
  extractDefinitionValue,
  indexSymbols,
} from "./meta/frontend/symbolTable.ts";
export {
  resolveExternalProgramReferences,
  resolveExternalTermReferences,
} from "./meta/frontend/substitution.ts";
export { resolvePoly } from "./meta/frontend/compilation.ts";

// Additional utility exports
export { ChurchN, UnChurchNumber } from "./ski/church.ts";
export { searchAVL } from "./data/avl/avlNode.ts";

// Cons cell utilities
export { cons, type ConsCell } from "./cons.ts";

// SKI terminal and expression utilities
export {
  I,
  K,
  S,
  type SKITerminal,
  type SKITerminalSymbol,
} from "./ski/terminal.ts";
export { prettyPrint as prettyPrintSKIExpression } from "./ski/expression.ts";
