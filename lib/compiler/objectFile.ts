/**
 * TripLang Object File Format (.tripc)
 *
 * This module defines the TypeScript interfaces for the standardized intermediate
 * "object file" format used by the TripLang compiler. Object files contain the
 * compiled representation of a single module that can be linked with other modules.
 *
 * @module
 */
import type { TripLangTerm } from "../meta/trip.ts";

/**
 * Represents an import declaration in a module.
 */
export interface ModuleImport {
  /** The name of the imported symbol */
  name: string;
  /** The module from which the symbol is imported */
  from: string;
}

/**
 * Represents the complete object file structure for a compiled TripLang module.
 *
 * This format contains all the information needed to:
 * - Identify the module and its dependencies
 * - Link with other modules during the linking phase
 * - Reconstruct the module's definitions during execution
 */
export interface TripCObject {
  /** The name of this module */
  module: string;

  /** List of symbols exported by this module */
  exports: string[];

  /** List of symbols imported by this module from other modules */
  imports: ModuleImport[];

  /** All definitions in this module, indexed by symbol name */
  definitions: Record<string, TripLangTerm>;
}

/**
 * Serializes a TripCObject to JSON string format.
 *
 * @param obj The object file to serialize
 * @returns JSON string representation of the object file
 */
const BIGINT_TAG = "__trip_bigint__";

export function serializeTripCObject(obj: TripCObject): string {
  const replacer = (_key: string, value: unknown) => {
    if (typeof value === "bigint") {
      return { [BIGINT_TAG]: value.toString() };
    }
    return value;
  };
  return JSON.stringify(obj, replacer, 2);
}

/**
 * Deserializes a JSON string back into a TripCObject.
 *
 * @param json The JSON string to deserialize
 * @returns The parsed object file
 * @throws Error if the JSON is invalid or doesn't match the expected format
 */
export function deserializeTripCObject(json: string): TripCObject {
  try {
    const reviver = (_key: string, value: unknown) => {
      if (
        value &&
        typeof value === "object" &&
        BIGINT_TAG in (value as Record<string, unknown>)
      ) {
        const serialized = (value as Record<string, unknown>)[BIGINT_TAG];
        if (typeof serialized !== "string") {
          throw new Error("Invalid bigint encoding in object file");
        }
        return BigInt(serialized);
      }
      return value;
    };
    const parsed = JSON.parse(json, reviver);

    // Basic validation
    if (typeof parsed.module !== "string") {
      throw new Error("Invalid object file: missing or invalid module name");
    }

    if (!Array.isArray(parsed.exports)) {
      throw new Error("Invalid object file: exports must be an array");
    }

    if (!Array.isArray(parsed.imports)) {
      throw new Error("Invalid object file: imports must be an array");
    }

    if (typeof parsed.definitions !== "object" || parsed.definitions === null) {
      throw new Error("Invalid object file: definitions must be an object");
    }

    // Validate imports structure
    for (const imp of parsed.imports) {
      if (typeof imp.name !== "string" || typeof imp.from !== "string") {
        throw new Error(
          "Invalid object file: import entries must have name and from strings",
        );
      }
    }

    return parsed as TripCObject;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid JSON in object file: ${error.message}`);
    }
    throw error;
  }
}
