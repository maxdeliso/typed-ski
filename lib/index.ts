/**
 * Typed SKI: parsing, pretty-printing, evaluation, typing, and TripLang compiler.
 *
 * This module re-exports the public API:
 * - SKI parsing/printing/types and the Thanatos-backed evaluator
 * - Untyped/typed lambda and System F term utilities
 * - Type utilities (pretty printing, inference)
 * - TripLang parsing and full compile pipeline (parse → index → elaborate → resolve → typecheck)
 *
 * @example
 * ```ts
 * import { createArenaEvaluator, parseSKI } from "jsr:@maxdeliso/typed-ski";
 * const expr = parseSKI("(K S) I");
 * const evaluator = await createArenaEvaluator();
 * const nf = await evaluator.reduce(expr);
 * ```
 *
 * @module
 */
// Thanatos evaluator exports
export {
  createArenaEvaluator,
  createThanatosEvaluator,
  defaultWorkerCount,
  getBatchBrokerEnvVarNames,
  ThanatosEvaluator,
  ThanatosUnavailableError,
  thanatosAvailable,
} from "./evaluator/thanatosEvaluator.ts";
export type {
  ThanatosBrokerConfig,
  ThanatosEvaluatorOptions,
  ThanatosReduceIoResult,
} from "./evaluator/thanatosEvaluator.ts";

// Constants
export { TEST_TIMEOUT_MS } from "./constants.ts";

// Module provider exports
export { getAvlObject } from "./avl.ts";
export { getBinObject } from "./bin.ts";
export { getNatObject } from "./nat.ts";
export { getPreludeObject } from "./prelude.ts";

// SKI expression exports
export {
  type SKIExpression,
  /** Unparses an SKI expression into a string representation. */
  unparseSKI,
} from "./ski/expression.ts";
export {
  type AsyncTopoDagWireChunkSink,
  combineTopoDagWires,
  createTopoDagWireDecoder,
  countTopoDagWireRecords,
  TOPO_DAG_WIRE_NULL_POINTER,
  TOPO_DAG_WIRE_POINTER_HEX_WIDTH,
  TOPO_DAG_WIRE_RECORD_WIDTH,
  TOPO_DAG_WIRE_SEPARATOR,
  TOPO_DAG_WIRE_TERM_WIDTH,
  TOPO_DAG_WIRE_STRIDE,
  TOPO_DAG_WIRE_TERMINAL_CHARS,
  type TopoDagWireChunkSink,
  TopoDagWireDecoder,
  type TopoDagWireEncodeOptions,
  type TopoDagWireRecordSlice,
  type TopoDagWireWriteResult,
  fromTopoDagWire,
  iterateTopoDagWireRecords,
  topoDagWireCharToSym,
  toTopoDagWire,
  toTopoDagWireChunks,
  writeTopoDagWire,
  writeTopoDagWireAsync,
} from "./ski/topoDagWire.ts";
export {
  DAG_TERMINAL_CHARS,
  dagCharToSym,
  fromDagWire,
  toDagWire,
} from "./ski/dagWire.ts";

// Parser exports
/** Parses a string representation of an SKI expression into its AST. */
export { parseSKI } from "./parser/ski.ts";

/** Parses a string representation of a System F term into its AST. */
export { parseSystemF } from "./parser/systemFTerm.ts";

// System F exports
export { type SystemFTerm } from "./terms/systemF.ts";
/** Unparses a System F term into a string representation. */
export { unparseSystemF } from "./parser/systemFTerm.ts";

// System F type exports
export {
  emptySystemFContext,
  /** Transforms a well-typed System F term into a simply typed lambda term. */
  eraseSystemF,
  /** Performs type checking on System F terms. */
  typecheck as typecheckSystemF,
} from "./types/systemF.ts";
/** Unparses a System F type into a string representation. */
export { unparseSystemFType } from "./parser/systemFType.ts";

// Conversion exports
/** Converts a lambda expression to SKI combinators using bracket abstraction. */
export { bracketLambda } from "./conversion/converter.ts";

// Type system exports
/** Unparses a type into a string representation. */
export { unparseType } from "./parser/type.ts";
/** Infers the type of a typed lambda expression. */
export { inferType } from "./types/inference.ts";

// TripLang compiler exports
/** Parses a string representation of a TripLang program into its AST. */
export { parseTripLang } from "./parser/tripLang.ts";
/** Compiles a given TripLang program through the full pipeline: parse → index → elaborate → resolve → typecheck. */
export { compile } from "./meta/frontend.ts";
export {
  type DataDefinition,
  type PolyDefinition,
  type TripLangProgram,
  type TripLangTerm,
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
  /** Runs the self-hosted compiler and verifies its output against the TypeScript compiler. */
  bootstrappedCompile,
  type BootstrappedCompileOptions,
  BootstrappedCompilerError,
  BootstrappedCompilerMismatchError,
  /** Compiles a TripLang source string to the final linked combinator string. */
  compileToCombinatorString,
} from "./compiler/combinatorCompiler.ts";

export {
  /** Compiles a single TripLang source string to a TripCObject. */
  compileToObjectFile,
  /** Compiles a single TripLang source string to a serialized .tripc object file. */
  compileToObjectFileString,
  compileTripBundleV1ToLlvm,
  compileTripModulesToLlvm,
  compileTripSourceToLlvm,
  type ModuleImport,
  parseTripBundleV1,
  parseTripBundleV1String,
  serializeTripBundleV1,
  serializeTripBundleV1ToString,
  summarizeTripBundleV1,
  SingleFileCompilerError,
  TripBundleV1Error,
  TRIP_BUNDLE_V1_MAGIC,
  type CompileTripModulesToLlvmOptions,
  type TripBundleV1,
  type TripBundleV1Module,
  type TripCObject,
} from "./compiler/index.ts";

export {
  anfToMiniCoreExpr,
  anfToMiniCoreFunction,
  anfToMiniCoreProgram,
  anfToBlockFunction,
  anfToBlockModule,
  compileMiniCoreModules,
  evaluateMiniCore,
  miniTypeEquals,
  miniTypeToString,
  NativeV1SubsetError,
  MiniCoreAnfValidationError,
  MiniCoreBlockLoweringError,
  MiniCoreCompileError,
  toAnfFunction,
  toAnfProgram,
  typeOfAnfAtom,
  typeOfAnfExpr,
  typeOfAnfValue,
  typeOfMiniCoreExpr,
  unparseBlock,
  unparseBlockModule,
  unparseAnfExpr,
  unparseAnfProgram,
  validateAnfExecutable,
  validateAnfModule,
  validateAnfProgram,
  validateNativeV1Subset,
  getRuntimeSymbolSignature,
  TRIP_RUNTIME_SYMBOLS,
  type AnfAlt,
  type AnfAtom,
  type AnfExpr,
  type AnfFunctionDef,
  type AnfProgram,
  type AnfValue,
  type Block,
  type BlockFunctionDef,
  type BlockInstruction,
  type BlockInstructionOp,
  type BlockModule,
  type BlockParam,
  type BlockTerminator,
  type BlockValueRef,
  type ConstructorInfo as MiniCoreConstructorInfo,
  type DataTypeDef as MiniCoreDataTypeDef,
  type EffectKind as MiniCoreEffectKind,
  type FunctionInfo as MiniCoreFunctionInfo,
  type MiniCoreEvalResult,
  type MiniCoreMetadata,
  type MiniCoreModuleSource,
  type MiniCoreTelemetry,
  type MiniType,
  type NativeV1SubsetValidationOptions,
  type Program as MiniCoreProgram,
  type RuntimeSymbol,
  type RuntimeSymbolSignature,
  type TypeId as MiniCoreTypeId,
  valueToNat,
} from "./minicore/index.ts";

// Additional utility exports
export {
  /** Creates a Church-encoded number from a JavaScript number. */
  ChurchN,
  /** Converts a Church-encoded number back into a standard JavaScript number. */
  UnChurchNumber,
} from "./ski/church.ts";

// SKI terminal and expression utilities
export {
  /** The I combinator (identity function). */
  I,
  /** The K combinator (constant function). */
  K,
  /** The readOne terminal (input). */
  ReadOne,
  /** The S combinator (substitution function). */
  S,
  type SKITerminal,
  type SKITerminalSymbol,
  /** The writeOne terminal (output). */
  WriteOne,
} from "./ski/terminal.ts";

export { unparseSKI as unparseSKIExpression } from "./ski/expression.ts";

export {
  randExpression,
  type RandomSource,
  randTerminal,
} from "./ski/generator.ts";
