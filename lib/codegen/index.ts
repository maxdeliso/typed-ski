/**
 * Code generation utilities
 *
 * This module provides tools for generating TypeScript code from Rust source,
 * ensuring type safety and consistency across language boundaries.
 *
 * @module
 */

export {
  generateArenaHeaderConstants,
  type ValidationResult,
} from "./arenaHeader.ts";

export {
  type ParsedStruct,
  parseRustStruct,
  type StructField,
} from "../parser/rustStruct.ts";
