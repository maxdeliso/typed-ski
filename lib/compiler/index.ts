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

// Final combinator compiler helpers
export {
  bootstrappedCompile,
  type BootstrappedCompileOptions,
  BootstrappedCompilerError,
  BootstrappedCompilerMismatchError,
  compileToCombinatorString,
} from "./combinatorCompiler.ts";
