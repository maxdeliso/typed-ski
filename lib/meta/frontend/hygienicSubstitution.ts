/**
 * Hygienic substitution functions for TripLang terms and types.
 *
 * This module provides hygienic substitution algorithms that avoid variable
 * capture by tracking bound variables and performing alpha-renaming when necessary.
 * These functions are used in the linker for cross-module dependency resolution.
 *
 * @module
 */
import type { TripLangValueType } from "../trip.ts";

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
