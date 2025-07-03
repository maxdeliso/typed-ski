import {
  createEmptyAVL,
  insertAVL,
  searchAVL,
} from "../../data/avl/avlNode.ts";
import { compareStrings } from "../../data/map/stringMap.ts";
import { prettyPrintTy } from "../../types/types.ts";
import type {
  SymbolTable,
  TripLangDefType,
  TripLangProgram,
  TripLangTerm,
  TypeDefinition,
} from "../trip.ts";
import { CompilationError } from "./compilation.ts";

export function indexSymbols(program: TripLangProgram): SymbolTable {
  let termMap = createEmptyAVL<string, TripLangTerm>();
  let tyMap = createEmptyAVL<string, TypeDefinition>();

  for (const term of program.terms) {
    switch (term.kind) {
      case "poly":
      case "typed":
      case "untyped":
      case "combinator":
        {
          if (searchAVL(termMap, term.name, compareStrings) !== undefined) {
            throw new CompilationError(
              `Duplicate definition: ${term.name}`,
              "index",
              { term },
            );
          }

          termMap = insertAVL(termMap, term.name, term, compareStrings);
        }
        break;
      case "type":
        {
          const typeDef = term;
          if (searchAVL(tyMap, term.name, compareStrings) !== undefined) {
            throw new CompilationError(
              `Duplicate type: ${prettyPrintTy(typeDef.type)}`,
              "index",
              { typeDef },
            );
          }

          tyMap = insertAVL(tyMap, term.name, typeDef, compareStrings);
        }
        break;
    }
  }
  return {
    terms: termMap,
    types: tyMap,
  };
}

export function resolveDefTerm(tt: TripLangTerm): TripLangDefType {
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
      throw new CompilationError(
        "Cannot resolve definition term for module/import/export",
        "resolve",
        { term: tt },
      );
  }
}
