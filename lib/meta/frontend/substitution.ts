/**
 * Reference resolution and substitution for TripLang programs.
 *
 * This module provides functionality to resolve external references in TripLang
 * programs by substituting term and type definitions from the symbol table.
 * It includes generic substitution algorithms and specialized handlers for
 * different term types.
 *
 * @module
 */
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
import { CompilationError } from "./compilation.ts";

/**
 * Hygienic substitution functions for TripLang terms and types.
 *
 * These functions provide hygienic substitution algorithms that avoid variable
 * capture by tracking bound variables and performing alpha-renaming when necessary.
 */

/**
 * Computes free term variables in a TripLang value type
 */
export function freeTermVars(t: TripLangValueType): Set<string> {
  const free = new Set<string>();

  function collect(t: TripLangValueType, bound: Set<string>) {
    switch (t.kind) {
      case "lambda-abs":
        collect(t.body, new Set([...bound, t.name]));
        break;
      case "systemF-abs":
        collect(t.typeAnnotation, bound);
        collect(t.body, new Set([...bound, t.name]));
        break;
      case "systemF-type-abs":
        collect(t.body, new Set([...bound, t.typeVar]));
        break;
      case "typed-lambda-abstraction":
        collect(t.ty, bound);
        collect(t.body, new Set([...bound, t.varName]));
        break;
      case "forall":
        collect(t.body, new Set([...bound, t.typeVar]));
        break;
      case "systemF-type-app":
        collect(t.term, bound);
        collect(t.typeArg, bound);
        break;
      case "non-terminal":
        collect(t.lft, bound);
        collect(t.rgt, bound);
        break;
      case "systemF-var":
      case "lambda-var":
        if (!bound.has(t.name)) {
          free.add(t.name);
        }
        break;
      case "type-var":
      case "terminal":
        break;
    }
  }

  collect(t, new Set());
  return free;
}

/**
 * Computes free type variables in a TripLang value type
 */
export function freeTypeVars(t: TripLangValueType): Set<string> {
  const free = new Set<string>();

  function collect(t: TripLangValueType, bound: Set<string>) {
    switch (t.kind) {
      case "lambda-abs":
        collect(t.body, bound);
        break;
      case "systemF-abs":
        collect(t.typeAnnotation, bound);
        collect(t.body, bound);
        break;
      case "systemF-type-abs":
        collect(t.body, new Set([...bound, t.typeVar]));
        break;
      case "typed-lambda-abstraction":
        collect(t.ty, bound);
        collect(t.body, bound);
        break;
      case "forall":
        collect(t.body, new Set([...bound, t.typeVar]));
        break;
      case "systemF-type-app":
        collect(t.term, bound);
        collect(t.typeArg, bound);
        break;
      case "non-terminal":
        collect(t.lft, bound);
        collect(t.rgt, bound);
        break;
      case "systemF-var":
      case "lambda-var":
        break;
      case "type-var":
        if (!bound.has(t.typeName)) {
          free.add(t.typeName);
        }
        break;
      case "terminal":
        break;
    }
  }

  collect(t, new Set());
  return free;
}

/**
 * Generates a fresh name avoiding conflicts
 */
export function fresh(base: string, avoid: Set<string>): string {
  let candidate = base;
  let counter = 0;
  while (avoid.has(candidate)) {
    candidate = `${base}_${counter}`;
    counter++;
  }
  return candidate;
}

/**
 * Alpha-renames term binders with capture-avoiding substitution
 */
export function alphaRenameTermBinder<T extends TripLangValueType>(
  term: T,
  oldName: string,
  newName: string,
): T {
  switch (term.kind) {
    case "lambda-abs": {
      const bind = term.name;
      // If this binder is the one we're renaming, update binder and rename in body.
      if (bind === oldName) {
        return {
          ...term,
          name: newName,
          body: alphaRenameTermBinder(term.body, oldName, newName),
        } as T;
      }
      // Shadowing: stop renaming under a different binder of same name.
      if (bind === newName) return term;
      return {
        ...term,
        body: alphaRenameTermBinder(term.body, oldName, newName),
      } as T;
    }
    case "typed-lambda-abstraction": {
      const bind = term.varName;
      const ty = alphaRenameTermBinder(term.ty, oldName, newName);
      if (bind === oldName) {
        return {
          ...term,
          varName: newName,
          ty,
          body: alphaRenameTermBinder(term.body, oldName, newName),
        } as T;
      }
      if (bind === newName) return { ...term, ty } as T;
      return {
        ...term,
        ty,
        body: alphaRenameTermBinder(term.body, oldName, newName),
      } as T;
    }
    case "systemF-abs": {
      const bind = term.name;
      const typeAnnotation = alphaRenameTermBinder(
        term.typeAnnotation,
        oldName,
        newName,
      );
      if (bind === oldName) {
        return {
          ...term,
          name: newName,
          typeAnnotation,
          body: alphaRenameTermBinder(term.body, oldName, newName),
        } as T;
      }
      if (bind === newName) return { ...term, typeAnnotation } as T;
      return {
        ...term,
        typeAnnotation,
        body: alphaRenameTermBinder(term.body, oldName, newName),
      } as T;
    }
    case "systemF-type-app":
      return {
        ...term,
        term: alphaRenameTermBinder(term.term, oldName, newName),
        typeArg: alphaRenameTermBinder(term.typeArg, oldName, newName),
      } as T;
    case "non-terminal":
      return {
        ...term,
        lft: alphaRenameTermBinder(term.lft, oldName, newName),
        rgt: alphaRenameTermBinder(term.rgt, oldName, newName),
      } as T;
    case "lambda-var":
    case "systemF-var":
      return term.name === oldName ? ({ ...term, name: newName } as T) : term;
    // Type binders/vars are separate namespace — don't touch here.
    default:
      return term;
  }
}

/**
 * Alpha-renames type binders with capture-avoiding substitution
 */
export function alphaRenameTypeBinder<T extends TripLangValueType>(
  term: T,
  oldName: string,
  newName: string,
): T {
  switch (term.kind) {
    case "forall": {
      const bind = term.typeVar;
      if (bind === oldName) {
        return {
          ...term,
          typeVar: newName,
          body: alphaRenameTypeBinder(term.body, oldName, newName),
        } as T;
      }
      if (bind === newName) return term;
      return {
        ...term,
        body: alphaRenameTypeBinder(term.body, oldName, newName),
      } as T;
    }
    case "systemF-type-abs": {
      const bind = term.typeVar;
      if (bind === oldName) {
        return {
          ...term,
          typeVar: newName,
          body: alphaRenameTypeBinder(term.body, oldName, newName),
        } as T;
      }
      if (bind === newName) return term;
      return {
        ...term,
        body: alphaRenameTypeBinder(term.body, oldName, newName),
      } as T;
    }
    case "systemF-type-app":
      return {
        ...term,
        term: alphaRenameTypeBinder(term.term, oldName, newName),
        typeArg: alphaRenameTypeBinder(term.typeArg, oldName, newName),
      } as T;
    case "typed-lambda-abstraction":
      return {
        ...term,
        ty: alphaRenameTypeBinder(term.ty, oldName, newName),
        body: alphaRenameTypeBinder(term.body, oldName, newName),
      } as T;
    case "systemF-abs":
      return {
        ...term,
        typeAnnotation: alphaRenameTypeBinder(
          term.typeAnnotation,
          oldName,
          newName,
        ),
        body: alphaRenameTypeBinder(term.body, oldName, newName),
      } as T;
    case "non-terminal":
      return {
        ...term,
        lft: alphaRenameTypeBinder(term.lft, oldName, newName),
        rgt: alphaRenameTypeBinder(term.rgt, oldName, newName),
      } as T;
    case "type-var":
      return term.typeName === oldName
        ? ({ ...term, typeName: newName } as T)
        : term;
    default:
      return term;
  }
}

/**
 * Scope-aware substitution that tracks bound variables during traversal
 */
export function substituteHygienic<T extends TripLangValueType>(
  term: T,
  termName: string,
  replacement: TripLangValueType,
  bound: Set<string> = new Set(),
): T {
  switch (term.kind) {
    case "lambda-abs": {
      const fv = freeTermVars(replacement);
      let bind = term.name;
      let currentTerm = term;
      if (fv.has(bind)) {
        const newName = fresh(bind, new Set([...fv, ...bound]));
        currentTerm = alphaRenameTermBinder(currentTerm, bind, newName) as T;
        bind = newName;
      }
      const newBound = new Set(bound);
      newBound.add(bind);
      return {
        ...currentTerm,
        body: substituteHygienic(
          (currentTerm as Extract<T, { kind: "lambda-abs" }>).body,
          termName,
          replacement,
          newBound,
        ),
      } as T;
    }
    case "systemF-abs": {
      const fv = freeTermVars(replacement);
      let bind = term.name;
      let currentTerm = term;
      if (fv.has(bind)) {
        const newName = fresh(bind, new Set([...fv, ...bound]));
        currentTerm = alphaRenameTermBinder(currentTerm, bind, newName) as T;
        bind = newName;
      }
      const newBound = new Set(bound);
      newBound.add(bind);
      return {
        ...currentTerm,
        typeAnnotation: substituteHygienic(
          (currentTerm as Extract<T, { kind: "systemF-abs" }>).typeAnnotation,
          termName,
          replacement,
          bound,
        ),
        body: substituteHygienic(
          (currentTerm as Extract<T, { kind: "systemF-abs" }>).body,
          termName,
          replacement,
          newBound,
        ),
      } as T;
    }
    case "systemF-type-abs":
      return {
        ...term,
        body: substituteHygienic(term.body, termName, replacement, bound),
      } as T;
    case "typed-lambda-abstraction": {
      const fv = freeTermVars(replacement);
      let bind = term.varName;
      let currentTerm = term;
      if (fv.has(bind)) {
        const newName = fresh(bind, new Set([...fv, ...bound]));
        currentTerm = alphaRenameTermBinder(currentTerm, bind, newName) as T;
        bind = newName;
      }
      const newBound = new Set(bound);
      newBound.add(bind);
      return {
        ...currentTerm,
        ty: substituteHygienic(
          (currentTerm as Extract<T, { kind: "typed-lambda-abstraction" }>).ty,
          termName,
          replacement,
          bound,
        ),
        body: substituteHygienic(
          (currentTerm as Extract<T, { kind: "typed-lambda-abstraction" }>)
            .body,
          termName,
          replacement,
          newBound,
        ),
      } as T;
    }
    case "forall":
      return {
        ...term,
        body: substituteHygienic(term.body, termName, replacement, bound),
      } as T;
    case "systemF-type-app":
      return {
        ...term,
        term: substituteHygienic(term.term, termName, replacement, bound),
        typeArg: substituteHygienic(term.typeArg, termName, replacement, bound),
      } as T;
    case "non-terminal":
      return {
        ...term,
        lft: substituteHygienic(term.lft, termName, replacement, bound),
        rgt: substituteHygienic(term.rgt, termName, replacement, bound),
      } as T;
    case "systemF-var":
    case "lambda-var":
      if (term.name === termName && !bound.has(term.name)) {
        return replacement as T;
      }
      return term;
    case "type-var":
    case "terminal":
      return term;
  }
}

/**
 * Scope-aware type variable substitution that tracks bound type variables during traversal
 */
export function substituteTypeHygienic<T extends TripLangValueType>(
  term: T,
  typeName: string,
  replacement: TripLangValueType,
  bound: Set<string> = new Set(),
): T {
  switch (term.kind) {
    case "forall": {
      const fv = freeTypeVars(replacement);
      let bind = term.typeVar;
      let currentTerm = term;
      if (fv.has(bind)) {
        const newName = fresh(bind, new Set([...fv, ...bound]));
        currentTerm = alphaRenameTypeBinder(currentTerm, bind, newName) as T;
        bind = newName;
      }
      const b = new Set(bound);
      b.add(bind);
      return {
        ...currentTerm,
        body: substituteTypeHygienic(
          (currentTerm as Extract<T, { kind: "forall" }>).body,
          typeName,
          replacement,
          b,
        ),
      } as T;
    }
    case "systemF-type-abs": {
      const fv = freeTypeVars(replacement);
      let bind = term.typeVar;
      let currentTerm = term;
      if (fv.has(bind)) {
        const newName = fresh(bind, new Set([...fv, ...bound]));
        currentTerm = alphaRenameTypeBinder(currentTerm, bind, newName) as T;
        bind = newName;
      }
      const b = new Set(bound);
      b.add(bind);
      return {
        ...currentTerm,
        body: substituteTypeHygienic(
          (currentTerm as Extract<T, { kind: "systemF-type-abs" }>).body,
          typeName,
          replacement,
          b,
        ),
      } as T;
    }
    case "systemF-type-app":
      return {
        ...term,
        term: substituteTypeHygienic(term.term, typeName, replacement, bound),
        typeArg: substituteTypeHygienic(
          term.typeArg,
          typeName,
          replacement,
          bound,
        ),
      } as T;
    case "typed-lambda-abstraction":
      return {
        ...term,
        ty: substituteTypeHygienic(term.ty, typeName, replacement, bound),
        body: substituteTypeHygienic(term.body, typeName, replacement, bound),
      } as T;
    case "systemF-abs":
      return {
        ...term,
        typeAnnotation: substituteTypeHygienic(
          term.typeAnnotation,
          typeName,
          replacement,
          bound,
        ),
        body: substituteTypeHygienic(term.body, typeName, replacement, bound),
      } as T;
    case "non-terminal":
      return {
        ...term,
        lft: substituteTypeHygienic(term.lft, typeName, replacement, bound),
        rgt: substituteTypeHygienic(term.rgt, typeName, replacement, bound),
      } as T;
    case "type-var":
      return (term.typeName === typeName && !bound.has(typeName)
        ? replacement as T
        : term);
    default:
      return term;
  }
}

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
  const externalTermRefs = Array.from(tRefs.keys());
  const externalTypeRefs = Array.from(tyRefs.keys());

  // First resolve all type references
  const withResolvedTypes = externalTypeRefs.reduce((acc, typeRef) => {
    const resolvedTy = syms.types.get(typeRef);

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
    const symbolReferencedTerm = syms.terms.get(termRef);
    const symbolReferencedType = syms.types.get(termRef);

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
 * Substitutes a referenced top-level term into another definition, using hygienic
 * substitution to avoid variable capture. Lowers the term to match levels if necessary.
 */
export function substituteTripLangTerm(
  current: TripLangTerm,
  term: TripLangTerm,
): TripLangTerm {
  while (termLevel(current) < termLevel(term)) {
    term = lower(term);
  }

  const currentDefinitionValue = extractDefinitionValue(current);
  if (!currentDefinitionValue) {
    return current;
  }

  const termDefinitionValue = extractDefinitionValue(term);
  if (!termDefinitionValue) {
    return current;
  }

  switch (current.kind) {
    case "poly": {
      return {
        kind: "poly",
        name: current.name,
        term: substituteHygienic(
          current.term,
          term.name,
          termDefinitionValue,
        ),
      };
    }
    case "typed": {
      return {
        kind: "typed",
        name: current.name,
        term: substituteHygienic(
          current.term,
          term.name,
          termDefinitionValue,
        ),
        type: undefined,
      };
    }
    case "untyped": {
      return {
        ...current,
        term: substituteHygienic(
          current.term,
          term.name,
          termDefinitionValue,
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
 * Substitutes a referenced type definition into a term definition, using hygienic
 * substitution to avoid variable capture.
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

  const currentDefinitionValue = extractDefinitionValue(current);
  if (!currentDefinitionValue) {
    return current;
  }

  const typeRef: string = type.name;
  const replacement: BaseType = type.type;

  switch (current.kind) {
    case "poly":
      return {
        ...current,
        term: substituteTypeHygienic(
          current.term,
          typeRef,
          replacement,
        ),
      };
    case "typed":
      return {
        ...current,
        term: substituteTypeHygienic(
          current.term,
          typeRef,
          replacement,
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

/**
 * Direct substitution without lowering - preserves term levels with hygienic binding
 */
export function substituteTripLangTermDirect(
  current: TripLangTerm,
  term: TripLangTerm,
  symbolName?: string,
): TripLangTerm {
  const currentDefinitionValue = extractDefinitionValue(current);
  if (!currentDefinitionValue) {
    return current;
  }

  const termDefinitionValue = extractDefinitionValue(term);
  if (!termDefinitionValue) {
    return current;
  }

  // Use the provided symbol name, or fall back to the term's name
  const substitutionName = symbolName ?? term.name;

  switch (current.kind) {
    case "poly": {
      return {
        kind: "poly",
        name: current.name,
        term: substituteHygienic(
          current.term,
          substitutionName,
          termDefinitionValue,
        ),
      };
    }
    case "typed": {
      return {
        kind: "typed",
        name: current.name,
        term: substituteHygienic(
          current.term,
          substitutionName,
          termDefinitionValue,
        ),
      };
    }
    case "untyped": {
      return {
        ...current,
        term: substituteHygienic(
          current.term,
          substitutionName,
          termDefinitionValue,
        ),
      };
    }
    case "combinator":
    case "type":
      throw new CompilationError(
        "Unexpected term kind for substitution",
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
 * Direct type substitution without lowering - preserves term levels with hygienic binding
 */
export function substituteTripLangTypeDirect(
  current: TripLangTerm,
  type: TripLangTerm,
): TripLangTerm {
  if (type.kind !== "type") {
    throw new CompilationError(
      "Expected type definition for type substitution",
      "resolve",
      { type },
    );
  }

  const currentDefinitionValue = extractDefinitionValue(current);
  if (!currentDefinitionValue) {
    return current;
  }

  const typeDefinitionValue = extractDefinitionValue(type);
  if (!typeDefinitionValue) {
    return current;
  }

  switch (current.kind) {
    case "poly": {
      return {
        ...current,
        term: substituteTypeHygienic(
          current.term,
          type.name,
          typeDefinitionValue,
        ),
      };
    }
    case "typed": {
      return {
        ...current,
        term: substituteTypeHygienic(
          current.term,
          type.name,
          typeDefinitionValue,
        ),
      };
    }
    case "untyped":
    case "combinator":
    case "module":
    case "import":
    case "export":
      return current;
    default:
      throw new CompilationError(
        "Unexpected term kind for type substitution",
        "resolve",
        { current },
      );
  }
}
