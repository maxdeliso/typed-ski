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
import type { TypedLambda } from "../../types/typedLambda.ts";
import type { UntypedLambda } from "../../terms/lambda.ts";
import type { SystemFTerm } from "../../terms/systemF.ts";
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
import { CompilationError } from "./errors.ts";
import { isNatLiteralIdentifier, NAT_TYPE_NAME } from "../../consts/nat.ts";

/**
 * Hygienic substitution functions for TripLang terms and types.
 *
 * These functions provide hygienic substitution algorithms that avoid variable
 * capture by tracking bound variables and performing alpha-renaming when necessary.
 */

/**
 * Global cache for free variables to avoid O(N^2) behavior in linker.
 */
const freeVarCache = new WeakMap<TripLangValueType, Set<string>>();

/**
 * Computes free term variables in a TripLang value type.
 * Uses iterative stack-based collector with tail-call optimization for App chains.
 * Prevents stack overflow on deep structures like lists.
 * Results are cached to avoid repeated traversals of the same AST nodes.
 */
export function freeTermVars(t: TripLangValueType): Set<string> {
  // Check cache first
  const cached = freeVarCache.get(t);
  if (cached) return cached;

  const result = new Set<string>();

  // Iterative stack
  const stack: { term: TripLangValueType; bound: Set<string> }[] = [
    { term: t, bound: new Set() },
  ];

  while (stack.length > 0) {
    let { term, bound } = stack.pop()!;

    // Tail-call optimization loop for App chains
    while (true) {
      switch (term.kind) {
        case "systemF-var":
          if (!isNatLiteralIdentifier(term.name) && !bound.has(term.name)) {
            result.add(term.name);
          }
          break;

        case "lambda-var":
          if (!bound.has(term.name)) {
            result.add(term.name);
          }
          break;

        case "non-terminal": {
          // Tail optimize: push left, loop on right (list tail)
          stack.push({ term: term.lft, bound });
          term = term.rgt;
          continue;
        }

        case "systemF-abs": {
          const newBound = new Set(bound);
          newBound.add(term.name);
          stack.push({ term: term.typeAnnotation, bound });
          stack.push({ term: term.body, bound: newBound });
          break;
        }

        case "lambda-abs": {
          const newBound = new Set(bound);
          newBound.add(term.name);
          stack.push({ term: term.body, bound: newBound });
          break;
        }

        case "typed-lambda-abstraction": {
          const newBound = new Set(bound);
          newBound.add(term.varName);
          stack.push({ term: term.ty, bound });
          stack.push({ term: term.body, bound: newBound });
          break;
        }

        case "systemF-let": {
          stack.push({ term: term.value, bound });
          const newBound = new Set(bound);
          newBound.add(term.name);
          stack.push({ term: term.body, bound: newBound });
          break;
        }

        case "systemF-match": {
          stack.push({ term: term.scrutinee, bound });
          stack.push({ term: term.returnType, bound });
          for (const arm of term.arms) {
            const armBound = new Set(bound);
            for (const param of arm.params) {
              armBound.add(param);
            }
            stack.push({ term: arm.body, bound: armBound });
          }
          break;
        }

        case "systemF-type-app": {
          stack.push({ term: term.term, bound });
          term = term.typeArg;
          continue;
        }

        case "systemF-type-abs": {
          const newBound = new Set(bound);
          newBound.add(term.typeVar);
          term = term.body;
          bound = newBound;
          continue;
        }

        case "forall": {
          const newBound = new Set(bound);
          newBound.add(term.typeVar);
          term = term.body;
          bound = newBound;
          continue;
        }

        case "type-app": {
          stack.push({ term: term.fn, bound });
          term = term.arg;
          continue;
        }

        case "type-var":
        case "terminal":
          break;
      }
      // If we didn't 'continue', we are done with this node.
      break;
    }
  }

  // Cache result before returning
  freeVarCache.set(t, result);
  return result;
}

function usesSystemFNatLiteral(term: TripLangValueType): boolean {
  const stack: TripLangValueType[] = [term];
  while (stack.length) {
    const current = stack.pop();
    if (!current) continue;
    switch (current.kind) {
      case "systemF-var":
        if (isNatLiteralIdentifier(current.name)) {
          return true;
        }
        break;
      case "systemF-abs":
        stack.push(current.typeAnnotation);
        stack.push(current.body);
        break;
      case "systemF-type-abs":
        stack.push(current.body);
        break;
      case "systemF-type-app":
        stack.push(current.term);
        stack.push(current.typeArg);
        break;
      case "type-app":
        stack.push(current.fn);
        stack.push(current.arg);
        break;
      case "systemF-match":
        stack.push(current.scrutinee);
        stack.push(current.returnType);
        for (const arm of current.arms) {
          stack.push(arm.body);
        }
        break;
      case "systemF-let":
        stack.push(current.value);
        stack.push(current.body);
        break;
      case "typed-lambda-abstraction":
        stack.push(current.ty);
        stack.push(current.body);
        break;
      case "lambda-abs":
        stack.push(current.body);
        break;
      case "forall":
        stack.push(current.body);
        break;
      case "non-terminal":
        stack.push(current.lft);
        stack.push(current.rgt);
        break;
      case "lambda-var":
      case "type-var":
      case "terminal":
        break;
    }
  }
  return false;
}

function ensureNatAvailabilityIfNeeded(
  term: TripLangTerm,
  value: TripLangValueType,
  syms: SymbolTable,
): void {
  if (!usesSystemFNatLiteral(value)) {
    return;
  }
  if (!syms.types.has(NAT_TYPE_NAME)) {
    throw new CompilationError(
      `Internal error: '${NAT_TYPE_NAME}' type missing during literal resolution`,
      "resolve",
      { term },
    );
  }
}

/**
 * Computes free type variables in a TripLang value type
 */
/**
 * Computes free type variables in a TripLang value type.
 * Uses mutable accumulator pattern to avoid quadratic Set copying.
 */
export function freeTypeVars(t: TripLangValueType): Set<string> {
  const free = new Set<string>();

  function collectFree(t: TripLangValueType, bound: Set<string>) {
    switch (t.kind) {
      case "lambda-abs":
        collectFree(t.body, bound);
        break;
      case "systemF-abs":
        collectFree(t.typeAnnotation, bound);
        collectFree(t.body, bound);
        break;
      case "systemF-type-abs":
        bound.add(t.typeVar);
        collectFree(t.body, bound);
        bound.delete(t.typeVar);
        break;
      case "typed-lambda-abstraction":
        collectFree(t.ty, bound);
        collectFree(t.body, bound);
        break;
      case "forall":
        bound.add(t.typeVar);
        collectFree(t.body, bound);
        bound.delete(t.typeVar);
        break;
      case "systemF-type-app":
        collectFree(t.term, bound);
        collectFree(t.typeArg, bound);
        break;
      case "systemF-match":
        collectFree(t.scrutinee, bound);
        collectFree(t.returnType, bound);
        for (const arm of t.arms) {
          // Note: arm.params are term variables, not type variables, so we don't add them to bound
          collectFree(arm.body, bound);
        }
        break;
      case "systemF-let":
        collectFree(t.value, bound);
        collectFree(t.body, bound);
        break;
      case "non-terminal":
        collectFree(t.lft, bound);
        collectFree(t.rgt, bound);
        break;
      case "systemF-var":
      case "lambda-var":
        break;
      case "type-app":
        collectFree(t.fn, bound);
        collectFree(t.arg, bound);
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

  collectFree(t, new Set());
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
    case "systemF-match": {
      const scrutinee = alphaRenameTermBinder(
        term.scrutinee,
        oldName,
        newName,
      );
      const returnType = alphaRenameTermBinder(
        term.returnType,
        oldName,
        newName,
      );
      const arms = term.arms.map((arm) => {
        if (arm.params.includes(newName)) {
          return arm;
        }
        if (!arm.params.includes(oldName)) {
          return {
            ...arm,
            body: alphaRenameTermBinder(arm.body, oldName, newName),
          };
        }
        const updatedParams = arm.params.map((param) =>
          param === oldName ? newName : param
        );
        return {
          ...arm,
          params: updatedParams,
          body: alphaRenameTermBinder(arm.body, oldName, newName),
        };
      });
      return { ...term, scrutinee, returnType, arms } as T;
    }
    case "systemF-let": {
      const bind = term.name;
      const value = alphaRenameTermBinder(term.value, oldName, newName);
      if (bind === oldName) {
        return {
          ...term,
          name: newName,
          value,
          body: alphaRenameTermBinder(term.body, oldName, newName),
        } as T;
      }
      if (bind === newName) return { ...term, value } as T;
      return {
        ...term,
        value,
        body: alphaRenameTermBinder(term.body, oldName, newName),
      } as T;
    }
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
    case "type-app":
      return {
        ...term,
        fn: alphaRenameTypeBinder(term.fn, oldName, newName),
        arg: alphaRenameTypeBinder(term.arg, oldName, newName),
      } as T;
    case "systemF-match": {
      const scrutinee = alphaRenameTypeBinder(
        term.scrutinee,
        oldName,
        newName,
      );
      const returnType = alphaRenameTypeBinder(
        term.returnType,
        oldName,
        newName,
      );
      const arms = term.arms.map((arm) => ({
        ...arm,
        body: alphaRenameTypeBinder(arm.body, oldName, newName),
      }));
      return { ...term, scrutinee, returnType, arms } as T;
    }
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
    case "systemF-let":
      return {
        ...term,
        value: alphaRenameTypeBinder(term.value, oldName, newName),
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
 * Batched version of substituteHygienic.
 * Substitutes multiple variables in one pass.
 * Preserves object identity if no changes are made (crucial for performance).
 *
 * @param replacementFVs Precomputed union of free variables from all replacements.
 *                        This allows O(1) capture checks instead of O(n) where n is number of replacements.
 */
export function substituteTermHygienicBatch(
  term: TripLangValueType,
  substitutions: Map<string, TripLangValueType>,
  replacementFVs: Set<string>,
  bound: Set<string> = new Set(),
): TripLangValueType {
  // Optimization: If map is empty, no work to do
  if (substitutions.size === 0) return term;

  switch (term.kind) {
    case "systemF-var":
    case "lambda-var": {
      // Don't substitute nat literal identifiers - they're special placeholders
      if (!isNatLiteralIdentifier(term.name) && !bound.has(term.name)) {
        const sub = substitutions.get(term.name);
        if (sub) return sub;
      }
      return term;
    }

    case "non-terminal": {
      const lft = substituteTermHygienicBatch(
        term.lft,
        substitutions,
        replacementFVs,
        bound,
      );
      const rgt = substituteTermHygienicBatch(
        term.rgt,
        substitutions,
        replacementFVs,
        bound,
      );
      // Preserve identity if unchanged
      if (lft === term.lft && rgt === term.rgt) return term;
      return { ...term, lft, rgt } as TripLangValueType;
    }

    case "systemF-abs": {
      // FAST CAPTURE CHECK: Use precomputed replacementFVs
      // If the binder name is present in ANY of the free variables of the replacements,
      // we must rename it to avoid capture.
      let bind = term.name;
      let currentTerm = term;
      if (replacementFVs.has(bind)) {
        // Generate fresh name
        const used = new Set([...replacementFVs, ...bound]);
        let suffix = 1;
        let newName = `${bind}_${suffix}`;
        while (used.has(newName)) {
          suffix++;
          newName = `${bind}_${suffix}`;
        }
        currentTerm = alphaRenameTermBinder(
          currentTerm,
          bind,
          newName,
        ) as typeof term;
        bind = newName;
      }

      const newBound = new Set(bound);
      newBound.add(bind);

      // Remove shadowed var from substitutions for the body
      let newSubs = substitutions;
      if (substitutions.has(bind)) {
        newSubs = new Map(substitutions);
        newSubs.delete(bind);
      }

      const typeAnnotation = substituteTermHygienicBatch(
        currentTerm.typeAnnotation,
        substitutions,
        replacementFVs,
        bound,
      );
      const body = substituteTermHygienicBatch(
        currentTerm.body,
        newSubs,
        replacementFVs,
        newBound,
      );

      // Preserve identity if unchanged
      if (
        typeAnnotation === term.typeAnnotation &&
        body === term.body &&
        bind === term.name
      ) {
        return term;
      }

      return {
        ...currentTerm,
        name: bind,
        typeAnnotation,
        body,
      } as TripLangValueType;
    }

    case "lambda-abs": {
      // FAST CAPTURE CHECK
      let bind = term.name;
      let currentTerm = term;
      if (replacementFVs.has(bind)) {
        const used = new Set([...replacementFVs, ...bound]);
        let suffix = 1;
        let newName = `${bind}_${suffix}`;
        while (used.has(newName)) {
          suffix++;
          newName = `${bind}_${suffix}`;
        }
        currentTerm = alphaRenameTermBinder(
          currentTerm,
          bind,
          newName,
        ) as typeof term;
        bind = newName;
      }

      const newBound = new Set(bound);
      newBound.add(bind);
      let newSubs = substitutions;
      if (substitutions.has(bind)) {
        newSubs = new Map(substitutions);
        newSubs.delete(bind);
      }

      const body = substituteTermHygienicBatch(
        currentTerm.body,
        newSubs,
        replacementFVs,
        newBound,
      );

      if (body === term.body && bind === term.name) return term;

      return {
        ...currentTerm,
        name: bind,
        body,
      } as TripLangValueType;
    }

    case "typed-lambda-abstraction": {
      // FAST CAPTURE CHECK
      let bind = term.varName;
      let currentTerm = term;
      if (replacementFVs.has(bind)) {
        const used = new Set([...replacementFVs, ...bound]);
        let suffix = 1;
        let newName = `${bind}_${suffix}`;
        while (used.has(newName)) {
          suffix++;
          newName = `${bind}_${suffix}`;
        }
        currentTerm = alphaRenameTermBinder(
          currentTerm,
          bind,
          newName,
        ) as typeof term;
        bind = newName;
      }

      const newBound = new Set(bound);
      newBound.add(bind);
      let newSubs = substitutions;
      if (substitutions.has(bind)) {
        newSubs = new Map(substitutions);
        newSubs.delete(bind);
      }

      const ty = substituteTermHygienicBatch(
        currentTerm.ty,
        substitutions,
        replacementFVs,
        bound,
      );
      const body = substituteTermHygienicBatch(
        currentTerm.body,
        newSubs,
        replacementFVs,
        newBound,
      );

      if (ty === term.ty && body === term.body && bind === term.varName) {
        return term;
      }

      return {
        ...currentTerm,
        varName: bind,
        ty: ty as BaseType,
        body: body as TypedLambda,
      } as TripLangValueType;
    }

    case "systemF-let": {
      // Value is in current scope
      const value = substituteTermHygienicBatch(
        term.value,
        substitutions,
        replacementFVs,
        bound,
      );

      // Body introduces binder - FAST CAPTURE CHECK
      let bind = term.name;
      let currentTerm = term;
      if (replacementFVs.has(bind)) {
        const used = new Set([...replacementFVs, ...bound]);
        let suffix = 1;
        let newName = `${bind}_${suffix}`;
        while (used.has(newName)) {
          suffix++;
          newName = `${bind}_${suffix}`;
        }
        currentTerm = alphaRenameTermBinder(
          currentTerm,
          bind,
          newName,
        ) as typeof term;
        bind = newName;
      }

      const newBound = new Set(bound);
      newBound.add(bind);
      let newSubs = substitutions;
      if (substitutions.has(bind)) {
        newSubs = new Map(substitutions);
        newSubs.delete(bind);
      }

      const body = substituteTermHygienicBatch(
        currentTerm.body,
        newSubs,
        replacementFVs,
        newBound,
      );

      if (value === term.value && body === term.body && bind === term.name) {
        return term;
      }

      return {
        ...currentTerm,
        name: bind,
        value,
        body,
      } as TripLangValueType;
    }

    case "systemF-match": {
      const scrutinee = substituteTermHygienicBatch(
        term.scrutinee,
        substitutions,
        replacementFVs,
        bound,
      );
      const returnType = substituteTermHygienicBatch(
        term.returnType,
        substitutions,
        replacementFVs,
        bound,
      );

      let armsChanged = false;
      const newArms = term.arms.map((arm) => {
        const armBound = new Set(bound);
        let armSubs = substitutions;
        const params = [...arm.params];

        // Check for capture and rename if needed using precomputed replacementFVs
        const avoid = new Set([...replacementFVs, ...bound, ...params]);
        let renamed = false;
        for (let i = 0; i < params.length; i++) {
          const param = params[i]!;
          if (replacementFVs.has(param)) {
            let suffix = 1;
            let newName = `${param}_${suffix}`;
            while (avoid.has(newName)) {
              suffix++;
              newName = `${param}_${suffix}`;
            }
            // Rename in body
            const renamedBody = alphaRenameTermBinder(arm.body, param, newName);
            params[i] = newName;
            armBound.add(newName);
            if (!renamed) {
              armSubs = new Map(armSubs);
              renamed = true;
            }
            armSubs.delete(newName);
            avoid.add(newName);

            const body = substituteTermHygienicBatch(
              renamedBody,
              armSubs,
              replacementFVs,
              armBound,
            );
            if (body !== arm.body) armsChanged = true;
            return { ...arm, params, body };
          } else {
            armBound.add(param);
            if (armSubs.has(param)) {
              if (!renamed) {
                armSubs = new Map(armSubs);
                renamed = true;
              }
              armSubs.delete(param);
            }
          }
        }

        if (!renamed) {
          const body = substituteTermHygienicBatch(
            arm.body,
            armSubs,
            replacementFVs,
            armBound,
          );
          if (body !== arm.body) armsChanged = true;
          return { ...arm, body };
        }

        return arm;
      });

      if (
        scrutinee === term.scrutinee && returnType === term.returnType &&
        !armsChanged
      ) {
        return term;
      }
      return {
        ...term,
        scrutinee,
        returnType,
        arms: newArms,
      } as TripLangValueType;
    }

    case "systemF-type-app": {
      const termPart = substituteTermHygienicBatch(
        term.term,
        substitutions,
        replacementFVs,
        bound,
      );
      const typeArg = substituteTermHygienicBatch(
        term.typeArg,
        substitutions,
        replacementFVs,
        bound,
      );
      if (termPart === term.term && typeArg === term.typeArg) return term;
      return {
        ...term,
        term: termPart as SystemFTerm,
        typeArg: typeArg as BaseType,
      } as TripLangValueType;
    }

    case "systemF-type-abs": {
      // Type binders don't shadow term variables
      const body = substituteTermHygienicBatch(
        term.body,
        substitutions,
        replacementFVs,
        bound,
      );
      if (body === term.body) return term;
      return { ...term, body: body as SystemFTerm } as TripLangValueType;
    }

    case "forall": {
      // Type binders don't shadow term variables
      const body = substituteTermHygienicBatch(
        term.body,
        substitutions,
        replacementFVs,
        bound,
      );
      if (body === term.body) return term;
      return { ...term, body: body as BaseType } as TripLangValueType;
    }

    case "type-app": {
      const fn = substituteTermHygienicBatch(
        term.fn,
        substitutions,
        replacementFVs,
        bound,
      );
      const arg = substituteTermHygienicBatch(
        term.arg,
        substitutions,
        replacementFVs,
        bound,
      );
      if (fn === term.fn && arg === term.arg) return term;
      return {
        ...term,
        fn: fn as BaseType,
        arg: arg as BaseType,
      } as TripLangValueType;
    }

    case "type-var":
    case "terminal":
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
    case "systemF-match": {
      const scrutinee = substituteHygienic(
        term.scrutinee,
        termName,
        replacement,
        bound,
      );
      const returnType = substituteHygienic(
        term.returnType,
        termName,
        replacement,
        bound,
      );
      const fv = freeTermVars(replacement);
      const arms = term.arms.map((arm) => {
        let body = arm.body;
        const params = [...arm.params];
        const avoid = new Set([...fv, ...bound, ...params]);

        for (let i = 0; i < params.length; i++) {
          const param = params[i]!;
          if (!fv.has(param)) continue;
          const newName = fresh(param, avoid);
          body = alphaRenameTermBinder(body, param, newName);
          params[i] = newName;
          avoid.add(newName);
        }

        const newBound = new Set(bound);
        params.forEach((param) => newBound.add(param));
        return {
          ...arm,
          params,
          body: substituteHygienic(body, termName, replacement, newBound),
        };
      });
      return { ...term, scrutinee, returnType, arms } as T;
    }
    case "systemF-let": {
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
        value: substituteHygienic(
          (currentTerm as Extract<T, { kind: "systemF-let" }>).value,
          termName,
          replacement,
          bound,
        ),
        body: substituteHygienic(
          (currentTerm as Extract<T, { kind: "systemF-let" }>).body,
          termName,
          replacement,
          newBound,
        ),
      } as T;
    }
    case "non-terminal":
      return {
        ...term,
        lft: substituteHygienic(term.lft, termName, replacement, bound),
        rgt: substituteHygienic(term.rgt, termName, replacement, bound),
      } as T;
    case "type-app":
      return {
        ...term,
        fn: substituteHygienic(term.fn, termName, replacement, bound),
        arg: substituteHygienic(term.arg, termName, replacement, bound),
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
    case "type-app":
      return {
        ...term,
        fn: substituteTypeHygienic(term.fn, typeName, replacement, bound),
        arg: substituteTypeHygienic(term.arg, typeName, replacement, bound),
      } as T;
    case "systemF-match": {
      const scrutinee = substituteTypeHygienic(
        term.scrutinee,
        typeName,
        replacement,
        bound,
      );
      const returnType = substituteTypeHygienic(
        term.returnType,
        typeName,
        replacement,
        bound,
      );
      const arms = term.arms.map((arm) => ({
        ...arm,
        body: substituteTypeHygienic(arm.body, typeName, replacement, bound),
      }));
      return { ...term, scrutinee, returnType, arms } as T;
    }
    case "systemF-let":
      return {
        ...term,
        value: substituteTypeHygienic(term.value, typeName, replacement, bound),
        body: substituteTypeHygienic(term.body, typeName, replacement, bound),
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
  // TripLang syntax: "import <module> <symbol>" (e.g., "import Prelude zero")
  // Parser produces: {name: moduleName, ref: symbolName}
  // We track the symbol name (ref) so imported symbols remain unresolved during substitution
  const importedSymbols = new Set<string>();
  for (const term of program.terms) {
    if (term.kind === "import") {
      importedSymbols.add(term.ref);
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

  ensureNatAvailabilityIfNeeded(term, definitionValue, syms);

  const [tRefs, tyRefs] = externalReferences(definitionValue);
  const externalTermRefs = Array.from(tRefs.keys());
  const externalTypeRefs = Array.from(tyRefs.keys());
  if (term.kind === "poly" && term.rec) {
    const idx = externalTermRefs.indexOf(term.name);
    if (idx !== -1) {
      externalTermRefs.splice(idx, 1);
    }
  }

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
        ...current,
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
    case "data":
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
        type: current.type
          ? substituteTypeHygienic(
            current.type,
            typeRef,
            replacement,
          )
          : current.type,
        term: substituteTypeHygienic(
          current.term,
          typeRef,
          replacement,
        ),
      };
    case "typed":
      return {
        ...current,
        type: current.type
          ? substituteTypeHygienic(
            current.type,
            typeRef,
            replacement,
          )
          : current.type,
        term: substituteTypeHygienic(
          current.term,
          typeRef,
          replacement,
        ),
      };
    case "data":
    case "untyped":
    case "combinator":
    case "module":
    case "import":
    case "export":
      return current;
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
        ...current,
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
    case "data":
    case "module":
    case "import":
    case "export":
      return current;
  }
}

/**
 * Batched version of substituteTripLangTermDirect.
 * Performs multiple term substitutions in a single pass.
 */
export function substituteTripLangTermDirectBatch(
  current: TripLangTerm,
  substitutions: Map<string, TripLangTerm>,
): TripLangTerm {
  if (substitutions.size === 0) return current;

  const currentDefinitionValue = extractDefinitionValue(current);
  if (!currentDefinitionValue) {
    return current;
  }

  // Build a map of name -> value for the batch substitution
  const valueSubstitutions = new Map<string, TripLangValueType>();
  for (const [name, term] of substitutions) {
    const value = extractDefinitionValue(term);
    if (value) {
      valueSubstitutions.set(name, value);
    }
  }

  if (valueSubstitutions.size === 0) return current;

  // OPTIMIZATION: Precompute union of free variables for all replacements.
  // This allows substituteTermHygienicBatch to check for capture in O(1) time
  // per node instead of iterating all substitutions.
  const combinedFVs = new Set<string>();
  for (const val of valueSubstitutions.values()) {
    const fvs = freeTermVars(val); // This is now CACHED
    for (const fv of fvs) combinedFVs.add(fv);
  }

  switch (current.kind) {
    case "poly": {
      const newTerm = substituteTermHygienicBatch(
        current.term,
        valueSubstitutions,
        combinedFVs,
      );
      if (newTerm === current.term) return current;
      return {
        ...current,
        term: newTerm as SystemFTerm,
      };
    }
    case "typed": {
      const newTerm = substituteTermHygienicBatch(
        current.term,
        valueSubstitutions,
        combinedFVs,
      );
      if (newTerm === current.term) return current;
      return {
        ...current,
        term: newTerm as TypedLambda,
      };
    }
    case "untyped": {
      const newTerm = substituteTermHygienicBatch(
        current.term,
        valueSubstitutions,
        combinedFVs,
      );
      if (newTerm === current.term) return current;
      return {
        ...current,
        term: newTerm as UntypedLambda,
      };
    }
    case "combinator":
    case "type":
    case "data":
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
        type: current.type
          ? substituteTypeHygienic(
            current.type,
            type.name,
            typeDefinitionValue,
          )
          : current.type,
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
        type: current.type
          ? substituteTypeHygienic(
            current.type,
            type.name,
            typeDefinitionValue,
          )
          : current.type,
        term: substituteTypeHygienic(
          current.term,
          type.name,
          typeDefinitionValue,
        ),
      };
    }
    case "type": {
      return {
        ...current,
        type: substituteTypeHygienic(
          current.type,
          type.name,
          typeDefinitionValue,
        ),
      };
    }
    case "data":
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
