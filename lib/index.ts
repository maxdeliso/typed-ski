// Core evaluator exports
export { symbolicEvaluator } from './evaluator/skiEvaluator.js';

// SKI expression exports
export {
  prettyPrint as prettyPrintSKI,
  type SKIExpression
} from './ski/expression.js';

// Parser exports
export { parseSKI } from './parser/ski.js';
export { parseLambda } from './parser/untyped.js';
export { parseSystemF } from './parser/systemFTerm.js';
export { parseTypedLambda } from './parser/typedLambda.js';

// Lambda terms exports
export {
  prettyPrintUntypedLambda,
  type UntypedLambda
} from './terms/lambda.js';

// System F exports
export {
  prettyPrintSystemF,
  type SystemFTerm
} from './terms/systemF.js';

// Typed Lambda exports
export {
  eraseTypedLambda,
  prettyPrintTypedLambda,
  type TypedLambda,
  typecheckTypedLambda as typecheckTyped
} from './types/typedLambda.js';

// System F type exports
export {
  eraseSystemF,
  prettyPrintSystemFType,
  typecheck as typecheckSystemF
} from './types/systemF.js';

// Conversion exports
export { bracketLambda } from './conversion/converter.js';

// Type system exports
export { prettyPrintTy } from './types/types.js';
export { inferType } from './types/inference.js';

// TripLang compiler exports
export { parseTripLang } from './parser/tripLang.js';
export { compile } from './meta/frontend.js';
export {
  type TripLangProgram,
  type TripLangTerm,
  type PolyDefinition,
  type TypedDefinition,
  type TypeDefinition
} from './meta/trip.js';
export { externalReferences } from './meta/frontend/externalReferences.js';
export { indexSymbols, resolveDefTerm } from './meta/frontend/symbolTable.js';
export { resolveRefs } from './meta/frontend/substitution.js';

// Additional utility exports
export { UnChurchNumber } from './ski/church.js';
export { searchAVL } from './data/avl/avlNode.js';
