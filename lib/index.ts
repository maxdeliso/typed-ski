/**
 * Typed SKI: parsing, pretty-printing, evaluation, typing, and TripLang compiler.
 *
 * This module re-exports the public API:
 * - SKI parsing/printing/types and the hash-consing arena evaluator
 * - Untyped/typed lambda and System F term utilities
 * - Type utilities (pretty printing, inference)
 * - TripLang parsing and full compile pipeline (parse → index → elaborate → resolve → typecheck)
 *
 * @example
 * ```ts
 * import { parseSKI, arenaEvaluator } from "jsr:@maxdeliso/typed-ski";
 * const expr = parseSKI("(K S) I");
 * const nf = arenaEvaluator.reduce(expr);
 * ```
 *
 * @module
 */
// Core evaluator exports
/** Default hash-consing arena evaluator singleton. */
export { arenaEvaluator } from "./evaluator/skiEvaluator.ts";

// WebAssembly arena evaluator exports
/** Creates a WebAssembly-based arena evaluator (release build). */
export {
  createArenaEvaluator,
  createArenaEvaluatorRelease,
} from "./evaluator/arenaEvaluator.ts";

// SKI expression exports
export {
  /** Generates a human-readable string representation of an SKI expression. */
  prettyPrint as prettyPrintSKI,
  type SKIExpression,
} from "./ski/expression.ts";

// Parser exports
/** Parses a string representation of an SKI expression into its AST. */
export { parseSKI } from "./parser/ski.ts";
/** Parses a string representation of an untyped lambda expression into its AST. */
export { parseLambda } from "./parser/untyped.ts";
/** Parses a string representation of a System F term into its AST. */
export { parseSystemF } from "./parser/systemFTerm.ts";
/** Parses a string representation of a typed lambda expression into its AST. */
export { parseTypedLambda } from "./parser/typedLambda.ts";

// Lambda terms exports
export {
  /** Generates a human-readable string representation of an untyped lambda expression. */
  prettyPrintUntypedLambda,
  type UntypedLambda,
} from "./terms/lambda.ts";

// System F exports
export {
  /** Generates a human-readable string representation of a System F term. */
  prettyPrintSystemF,
  type SystemFTerm,
} from "./terms/systemF.ts";

// Typed Lambda exports
export {
  /** Converts a typed lambda expression into an untyped lambda expression by removing type annotations. */
  eraseTypedLambda,
  /** Generates a human-readable string representation of a typed lambda expression. */
  prettyPrintTypedLambda,
  /** Performs type checking on a typed lambda expression to ensure type correctness. */
  typecheckTypedLambda as typecheckTyped,
  type TypedLambda,
} from "./types/typedLambda.ts";

// System F type exports
export {
  emptySystemFContext,
  /** Transforms a well-typed System F term into a simply typed lambda term. */
  eraseSystemF,
  /** Generates a human-readable string representation of a System F type. */
  prettyPrintSystemFType,
  /** Performs type checking on System F terms. */
  typecheck as typecheckSystemF,
} from "./types/systemF.ts";

// Conversion exports
/** Converts a lambda expression to SKI combinators using bracket abstraction. */
export { bracketLambda } from "./conversion/converter.ts";

// Type system exports
/** Generates a human-readable string representation of a type. */
export { prettyPrintTy } from "./types/types.ts";
/** Infers the type of a typed lambda expression. */
export { inferType } from "./types/inference.ts";

// TripLang compiler exports
/** Parses a string representation of a TripLang program into its AST. */
export { parseTripLang } from "./parser/tripLang.ts";
/** Compiles a given TripLang program through the full pipeline: parse → index → elaborate → resolve → typecheck. */
export { compile } from "./meta/frontend.ts";
export {
  type PolyDefinition,
  type TripLangProgram,
  type TripLangTerm,
  type TypedDefinition,
  type TypeDefinition,
} from "./meta/trip.ts";
/** Collects all free (external) term and type references appearing inside a TripLang value. */
export { externalReferences } from "./meta/frontend/externalReferences.ts";
export {
  /** Extracts the value part of a TripLang definition. */
  extractDefinitionValue,
  /** Indexes symbols within the SKI environment for efficient lookup and retrieval. */
  indexSymbols,
} from "./meta/frontend/symbolTable.ts";
export {
  /** Resolves references to external programs within the SKI environment. */
  resolveExternalProgramReferences,
  /** Resolves references to external terms within the SKI environment. */
  resolveExternalTermReferences,
} from "./meta/frontend/substitution.ts";
/** Resolves polymorphic definitions in a TripLang program. */
export { resolvePoly } from "./meta/frontend/compilation.ts";

// Phase 1 Single-File Compiler exports
export {
  /** Compiles a single TripLang source string to a TripCObject. */
  compileToObjectFile,
  /** Compiles a single TripLang source string to a serialized .tripc object file. */
  compileToObjectFileString,
  type ModuleImport,
  SingleFileCompilerError,
  type TripCObject,
} from "./compiler/index.ts";

// Additional utility exports
export {
  /** Creates a Church-encoded number from a JavaScript number. */
  ChurchN,
  /** Converts a Church-encoded number back into a standard JavaScript number. */
  UnChurchNumber,
} from "./ski/church.ts";
/** Searches for a key in an AVL tree and returns the associated value or undefined if not found. */
export { searchAVL } from "./data/avl/avlNode.ts";

// SKI terminal and expression utilities
export {
  /** The I combinator (identity function). */
  I,
  /** The K combinator (constant function). */
  K,
  /** The S combinator (substitution function). */
  S,
  type SKITerminal,
  type SKITerminalSymbol,
} from "./ski/terminal.ts";
/** Generates a human-readable string representation of an SKI expression. */
export { prettyPrint as prettyPrintSKIExpression } from "./ski/expression.ts";
