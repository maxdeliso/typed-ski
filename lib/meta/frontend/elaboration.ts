/**
 * Term elaboration and desugaring.
 *
 * This module provides functionality for elaborating TripLang terms,
 * including desugaring operations and type annotation propagation
 * for System F terms.
 *
 * @module
 */
import { searchAVL } from "../../data/avl/avlNode.ts";
import { compareStrings } from "../../data/map/stringMap.ts";
import type { SymbolTable, TripLangProgram, TripLangTerm } from "../trip.ts";
import {
  mkSystemFAbs,
  mkSystemFTAbs,
  mkSystemFTypeApp,
  type SystemFTerm,
} from "../../terms/systemF.ts";
import type { BaseType } from "../../types/types.ts";
import { cons } from "../../cons.ts";

export function elaborateTerms(
  parsed: TripLangProgram,
  syms: SymbolTable,
): TripLangProgram {
  return {
    kind: "program",
    terms: parsed.terms.map((t) => elaborateTerm(t, syms)),
  };
}

export function elaborateTerm(
  term: TripLangTerm,
  syms: SymbolTable,
): TripLangTerm {
  switch (term.kind) {
    case "poly":
      return {
        ...term,
        term: elaborateSystemF(term.term, syms),
      };
    case "typed":
      return term;
    case "untyped":
      return term;
    case "combinator":
      return term;
    case "type":
      return term;
    case "module":
      return term;
    case "import":
      return term;
    case "export":
      return term;
  }
}

function getTypeFromVar(
  term: SystemFTerm,
  syms: SymbolTable,
): BaseType | undefined {
  if (term.kind === "systemF-var") {
    return searchAVL(syms.types, term.name, compareStrings)?.type;
  }
  return undefined;
}

export function elaborateSystemF(
  systemF: SystemFTerm,
  syms: SymbolTable,
): SystemFTerm {
  switch (systemF.kind) {
    case "systemF-var":
      return systemF;
    case "systemF-abs":
      return mkSystemFAbs(
        systemF.name,
        systemF.typeAnnotation,
        elaborateSystemF(systemF.body, syms),
      );
    case "systemF-type-abs":
      return mkSystemFTAbs(
        systemF.typeVar,
        elaborateSystemF(systemF.body, syms),
      );
    case "systemF-type-app":
      return mkSystemFTypeApp(
        elaborateSystemF(systemF.term, syms),
        systemF.typeArg,
      );
    case "non-terminal": {
      const elaboratedLft = elaborateSystemF(systemF.lft, syms);
      const elaboratedRgt = elaborateSystemF(systemF.rgt, syms);
      const typeArg = getTypeFromVar(elaboratedRgt, syms);

      if (typeArg) {
        return mkSystemFTypeApp(elaboratedLft, typeArg);
      }

      return cons(elaboratedLft, elaboratedRgt);
    }
  }
}
