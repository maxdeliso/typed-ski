/**
 * Symbol table management for TripLang programs.
 *
 * This module provides functionality for building and managing symbol tables
 * for TripLang programs, including indexing terms and types and extracting
 * definition values.
 *
 * @module
 */
import { unparseType } from "../../parser/type.ts";
import type {
  SymbolTable,
  TripLangProgram,
  TripLangTerm,
  TripLangValueType,
  TypeDefinition,
} from "../trip.ts";
import { CompilationError } from "./compilation.ts";

/**
 * Builds a symbol table for a TripLang program, ensuring all term and type names are unique.
 *
 * @throws CompilationError when a duplicate term or type definition is encountered
 * @param program the TripLang program
 * @returns a `SymbolTable` containing Maps of term and type definitions by name
 */
export function indexSymbols(program: TripLangProgram): SymbolTable {
  const termMap = new Map<string, TripLangTerm>();
  const tyMap = new Map<string, TypeDefinition>();

  for (const term of program.terms) {
    switch (term.kind) {
      case "poly":
      case "typed":
      case "untyped":
      case "combinator":
        {
          if (termMap.has(term.name)) {
            throw new CompilationError(
              `Duplicate definition: ${term.name}`,
              "index",
              { term },
            );
          }

          termMap.set(term.name, term);
        }
        break;
      case "type":
        {
          const typeDef = term;
          if (tyMap.has(term.name)) {
            throw new CompilationError(
              `Duplicate type: ${unparseType(typeDef.type)}`,
              "index",
              { typeDef },
            );
          }

          tyMap.set(term.name, typeDef);
        }
        break;
    }
  }
  return {
    terms: termMap,
    types: tyMap,
  };
}

/**
 * Extracts the value part of a TripLang definition.
 *
 * For term definitions, returns the term; for type definitions, returns the type.
 * For module/import/export declarations, returns `undefined`.
 *
 * @param tt a TripLang term/definition
 * @returns the contained value (term or type), or `undefined` if not applicable
 */
export function extractDefinitionValue(
  tt: TripLangTerm,
): TripLangValueType | undefined {
  switch (tt.kind) {
    case "poly":
    case "typed":
    case "untyped":
    case "combinator":
      return tt.term;
    case "type":
      return tt.type;
    case "module":
    case "import":
    case "export":
      return undefined;
  }
}
