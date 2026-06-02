/**
 * TripLang Compiler Module
 *
 * This module exports the TripLang LLVM backend and bundle-v1 helpers.
 *
 * @module
 */

// LLVM textual IR backend
export {
  emitLlvmModule,
  LlvmEmissionError,
  LlvmV0ValidationError,
  validateLlvmV0,
  type EmitLlvmOptions,
  type LlvmIncomingEdge,
  type LlvmIncomingEdges,
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
  summarizeTripBundleV1Inventory,
  summarizeTripBundleV1ModuleEnv,
  summarizeTripBundleV1ParsedModules,
  TripBundleV1Error,
  TRIP_BUNDLE_V1_MAGIC,
  type TripBundleV1,
  type TripBundleV1Module,
} from "./bundleV1.ts";
