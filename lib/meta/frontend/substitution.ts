import { keyValuePairs, searchAVL } from "../../data/avl/avlNode.ts";
import { compareStrings } from "../../data/map/stringMap.ts";
import type { BaseType } from "../../types/types.ts";
import type {
  SymbolTable,
  TripLangProgram,
  TripLangTerm,
  TripLangValueType,
  TypeDefinition,
} from "../trip.ts";
import { lower, termLevel } from "./termLevel.ts";
import { extractDefinitionValue } from "./symbolTable.ts";
import { externalReferences } from "./externalReferences.ts";
import { mkBranch } from "./builders.ts";
import { needsRebuild, needsReplace } from "./predicates.ts";
import { replace as replaceTerm, typedTypeReplace } from "./replacers.ts";
import {
  polyRebuild,
  polyTypeRebuild,
  typedRebuild,
  typedTypeRebuild,
  untypedRebuild,
} from "./rebuilders.ts";
import { CompilationError } from "./compilation.ts";

/**
 * Resolves all external references across a program using the provided symbol table.
 *
 * Imported symbols are left unresolved by design.
 *
 * @param program the program whose definitions should be resolved
 * @param syms the symbol table built for the program
 * @returns a new program with references substituted where possible
 */
export function resolveExternalProgramReferences(
  program: TripLangProgram,
  syms: SymbolTable,
): TripLangProgram {
  // Collect all imported symbol names
  const importedSymbols = new Set<string>();
  for (const term of program.terms) {
    if (term.kind === "import") {
      importedSymbols.add(term.name);
    }
  }

  return {
    kind: "program",
    terms: program.terms.map((t) =>
      resolveExternalTermReferences(t, syms, importedSymbols)
    ),
  };
}

/**
 * Resolves external references inside a single top-level definition.
 *
 * Type references are substituted first, followed by term references. If a reference is
 * not found and is not imported, an error is thrown.
 *
 * @param term the top-level definition to resolve
 * @param syms the symbol table to resolve against
 * @param importedSymbols names declared as imports that should remain unresolved
 */
export function resolveExternalTermReferences(
  term: TripLangTerm,
  syms: SymbolTable,
  importedSymbols: Set<string>,
): TripLangTerm {
  const definitionValue = extractDefinitionValue(term);

  if (definitionValue === undefined) {
    return term;
  }

  const [tRefs, tyRefs] = externalReferences(definitionValue);
  const externalTermRefs = keyValuePairs(tRefs).map((kvp) => kvp[0]);
  const externalTypeRefs = keyValuePairs(tyRefs).map((kvp) => kvp[0]);

  // First resolve all type references
  const withResolvedTypes = externalTypeRefs.reduce((acc, typeRef) => {
    const resolvedTy = searchAVL(syms.types, typeRef, compareStrings);

    if (resolvedTy === undefined) {
      throw new CompilationError(
        `Unresolved external type reference: ${typeRef}`,
        "resolve",
        { typeRef, syms },
      );
    }

    return substituteTripLangType(acc, resolvedTy);
  }, term);

  // Then resolve all term references
  return externalTermRefs.reduce((acc, termRef) => {
    const symbolReferencedTerm = searchAVL(syms.terms, termRef, compareStrings);
    const symbolReferencedType = searchAVL(syms.types, termRef, compareStrings);

    if (
      symbolReferencedTerm === undefined && symbolReferencedType === undefined
    ) {
      // Skip imported symbols - they should remain unresolved
      if (importedSymbols.has(termRef)) {
        return acc;
      }

      throw new CompilationError(
        `Unresolved external term reference: ${termRef}`,
        "resolve",
        { termRef, syms },
      );
    }

    if (
      symbolReferencedTerm !== undefined && symbolReferencedType !== undefined
    ) {
      throw new CompilationError(
        `Duplicate external term reference resolution: ${termRef}`,
        "resolve",
        { termRef, syms },
      );
    }

    if (symbolReferencedTerm) {
      // note: the symbol referenced term may need resolution too,
      // so we recursively resolve it here
      const toInsert = resolveExternalTermReferences(
        symbolReferencedTerm,
        syms,
        importedSymbols,
      );
      return substituteTripLangTerm(acc, toInsert);
    }

    if (symbolReferencedType) {
      const withType = substituteTripLangType(acc, symbolReferencedType);
      // note: system F types can appear in terms
      return substituteTripLangTerm(withType, symbolReferencedType);
    }

    return acc;
  }, withResolvedTypes);
}

/**
 * Substitutes a referenced top-level term into another definition, rebuilding nodes
 * as necessary to preserve structure and levels.
 */
export function substituteTripLangTerm(
  current: TripLangTerm,
  term: TripLangTerm,
): TripLangTerm {
  while (termLevel(current) < termLevel(term)) {
    term = lower(term);
  }

  switch (current.kind) {
    case "poly": {
      return {
        kind: "poly",
        name: current.name,
        term: substitute(
          current.term,
          mkBranch,
          (n) => needsReplace(n, term.name),
          (n) => replaceTerm(n, term),
          needsRebuild,
          (n, rebuilt) => polyRebuild(n, rebuilt, term),
        ),
      };
    }
    case "typed": {
      return {
        kind: "typed",
        name: current.name,
        term: substitute(
          current.term,
          mkBranch,
          (n) => needsReplace(n, term.name),
          (n) => replaceTerm(n, term),
          needsRebuild,
          typedRebuild,
        ),
        type: undefined,
      };
    }
    case "untyped": {
      return {
        ...current,
        term: substitute(
          current.term,
          mkBranch,
          (n) => needsReplace(n, term.name),
          (n) => replaceTerm(n, term),
          needsRebuild,
          untypedRebuild,
        ),
      };
    }
    case "combinator":
    case "type":
      throw new CompilationError(
        "Unexpected current kind on LHS",
        "resolve",
        { current },
      );
    case "module":
    case "import":
    case "export":
      return current;
  }
}

/**
 * Substitutes a referenced type definition into a term definition, rebuilding nodes
 * and applying typed replacements where required.
 */
export function substituteTripLangType(
  current: TripLangTerm,
  type: TypeDefinition,
): TripLangTerm {
  if (current.kind === "type") {
    throw new CompilationError(
      "Substitutions never have types on LHS",
      "resolve",
      { current },
    );
  }

  const typeRef: string = type.name;
  const targetBase: BaseType = type.type;

  switch (current.kind) {
    case "poly":
      return {
        ...current,
        term: substitute(
          current.term,
          mkBranch,
          () => false, // note: all rebuilding happens at junction nodes
          (n) => n,
          needsRebuild,
          (n, rebuilt) => polyTypeRebuild(n, rebuilt, typeRef, targetBase),
        ),
      };
    case "typed":
      return {
        ...current,
        term: substitute(
          current.term,
          mkBranch,
          (n) => needsReplace(n, typeRef),
          (n) => typedTypeReplace(n, typeRef, targetBase),
          needsRebuild,
          typedTypeRebuild,
        ),
      };
    case "untyped":
    case "combinator":
    case "module":
    case "import":
    case "export":
      return {
        ...current,
      };
  }
}

/**
 * Generic non-recursive substitution engine over TripLang values.
 *
 * Traverses with an explicit stack, applying either replacement or rebuild functions
 * depending on the node encountered.
 */
export function substitute<T extends TripLangValueType>(
  current: T,
  mkBranchFn: (_: T) => T[],
  replaceNeeded: (_: T) => boolean,
  replaceFn: (_: T) => T,
  rebuildNeeded: (_: T) => boolean,
  rebuildFn: (_1: T, _2: T[]) => T,
): T {
  type Frame = [node: T, visited: boolean];
  const work: Frame[] = [[current, false]];
  const rebuilt: T[] = [];

  while (work.length > 0) {
    const r = work.pop();
    if (!r) continue;

    const [n, seen] = r;

    if (!seen) {
      work.push([n, true]);
      const branches = mkBranchFn(n);
      branches.forEach((branch) => work.push([branch, false]));
    } else if (rebuildNeeded(n)) {
      rebuilt.push(rebuildFn(n, rebuilt));
    } else if (replaceNeeded(n)) {
      rebuilt.push(replaceFn(n));
    } else {
      rebuilt.push(n);
    }
  }

  const result = rebuilt.pop();
  if (result === undefined) {
    throw new CompilationError(
      "Substitution failed: no result found",
      "resolve",
      { term: current, substitutions: rebuilt },
    );
  }
  return result;
}
