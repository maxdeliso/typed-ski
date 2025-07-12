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

// Additional utility exports
export { UnChurchNumber } from "./ski/church.ts";
export { searchAVL } from "./data/avl/avlNode.ts";
