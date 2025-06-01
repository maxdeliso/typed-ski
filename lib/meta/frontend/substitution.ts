import { keyValuePairs, searchAVL } from "../../data/avl/avlNode.ts";
import { compareStrings } from "../../data/map/stringMap.ts";
import { BaseType } from "../../types/types.ts";
import {
  SymbolTable,
  TripLangDefType,
  TripLangProgram,
  TripLangTerm,
  TypeDefinition,
} from "../trip.ts";
import { lower, termLevel } from "./termLevel.ts";
import { resolveDefTerm } from "./symbolTable.ts";
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

export function resolveRefs(
  program: TripLangProgram,
  syms: SymbolTable,
): TripLangProgram {
  return {
    kind: "program",
    terms: program.terms.map((t) => resolveTermRefs(t, syms)),
  };
}

export function resolveTermRefs(
  term: TripLangTerm,
  syms: SymbolTable,
): TripLangTerm {
  const programTerm = resolveDefTerm(term);
  const [tRefs, tyRefs] = externalReferences(programTerm);
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
      const toInsert = resolveTermRefs(symbolReferencedTerm, syms);
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
  }
}

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
      return {
        ...current,
      };
  }
}

export function substitute<T extends TripLangDefType>(
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
