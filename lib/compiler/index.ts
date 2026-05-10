/**
 * TripLang Compiler Module
 *
 * This module provides the Phase 1 single-file compiler functionality for TripLang.
 * It exports the core compilation functions and object file format definitions.
 *
 * @module
 */

// Object file format
export type { ModuleImport, TripCObject } from "./objectFile.ts";
export { deserializeTripCObject, serializeTripCObject } from "./objectFile.ts";

// Single-file compiler
export { SingleFileCompilerError } from "./singleFileCompiler.ts";
export {
  compileToObjectFile,
  type CompileToObjectFileOptions,
  compileToObjectFileString,
} from "./singleFileCompiler.ts";

// LLVM textual IR backend
export {
  emitLlvmModule,
  LlvmEmissionError,
  LlvmV0ValidationError,
  validateLlvmV0,
  type EmitLlvmOptions,
  type LlvmIncomingEdge,
  type LlvmIncomingEdges,
  type LlvmMainWrapper,
  type LlvmRepresentation,
  type LlvmTargetProfile,
} from "./llvm/index.ts";
export {
  compileTripBundleV1ToLlvm,
  compileTripModulesToLlvm,
  compileTripSourceToLlvm,
  moduleNameOfTripSource,
  parseLlvmTarget,
  parseModuleSourceSpec,
  readModuleSourceSpec,
  type CompileTripModulesToLlvmOptions,
  type CompileTripSourceToLlvmOptions,
  type TripModuleSourceFileSpec,
} from "./llvmCompiler.ts";
export {
  parseTripBundleV1,
  parseTripBundleV1String,
  serializeTripBundleV1,
  serializeTripBundleV1ToString,
  summarizeTripBundleV1,
  TripBundleV1Error,
  TRIP_BUNDLE_V1_MAGIC,
  type TripBundleV1,
  type TripBundleV1Module,
} from "./bundleV1.ts";
