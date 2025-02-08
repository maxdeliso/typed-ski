import { cons } from '../cons.ts';
import { BaseType, arrow, typesLitEq, prettyPrintTy, TypeVariable, mkTypeVariable } from './types.ts';
import { UntypedLambda } from '../terms/lambda.ts';
import { TypedLambda, mkTypedAbs, Context } from './typedLambda.ts';
import { varSource } from './varSource.ts';
import { normalizeTy } from './normalization.ts';

/**
 * Checks whether the type variable tv occurs in ty.
 */
const occursIn = (tv: TypeVariable, ty: BaseType): boolean => {
  if (ty.kind === 'type-var') {
    return ty.typeName === tv.typeName;
  } else if (ty.kind === 'non-terminal') {
    return occursIn(tv, ty.lft) || occursIn(tv, ty.rgt);
  } else {
    // If the bound variable is the same as tv, then tv is not free in this type.
    if (ty.typeVar === tv.typeName) {
      return false;
    } else {
      return occursIn(tv, ty.body);
    }
  }
};

/**
 * Substitute in the type “original” all free occurrences of the type pattern `lft`
 * with the replacement type `rgt`.
 */
export const substituteType = (
  original: BaseType,
  lft: BaseType,
  rgt: BaseType
): BaseType => {
  if (typesLitEq(lft, original)) {
    if (lft.kind === 'type-var' && occursIn(lft, rgt)) {
      throw new TypeError(
        `occurs check failed: ${lft.typeName} occurs in ${prettyPrintTy(rgt)}`
      );
    }
    return rgt;
  }
  switch (original.kind) {
    case 'type-var':
      return original;
    case 'non-terminal':
      return cons(
        substituteType(original.lft, lft, rgt),
        substituteType(original.rgt, lft, rgt)
      );
    case 'forall':
      // If the bound variable is the same as the pattern we wish to substitute,
      // do not substitute in the body (the binder shadows it).
      if (lft.kind === 'type-var' && original.typeVar === lft.typeName) {
        return original;
      } else {
        return {
          kind: 'forall',
          typeVar: original.typeVar,
          body: substituteType(original.body, lft, rgt)
        };
      }
    default:
      throw new Error('unhandled type in substitution');
  }
};

/**
 * The heart of Algorithm W.
 */
const algorithmW = (
  term: UntypedLambda,
  nextVar: () => TypeVariable,
  varBindings: Context,
  constraints: Context
): BaseType => {
  switch (term.kind) {
    case 'lambda-var': {
      const contextType = varBindings.get(term.name);
      if (contextType !== undefined) {
        return contextType;
      } else {
        return nextVar();
      }
    }
    case 'lambda-abs': {
      const paramType = nextVar();
      varBindings.set(term.name, paramType);
      constraints.set(term.name, paramType);
      const bodyType = algorithmW(term.body, nextVar, varBindings, constraints);
      return arrow(paramType, bodyType);
    }
    case 'non-terminal': {
      const leftTy = algorithmW(term.lft, nextVar, varBindings, constraints);
      const rgtTy = algorithmW(term.rgt, nextVar, varBindings, constraints);
      const result = nextVar();
      unify(leftTy, arrow(rgtTy, result), constraints);
      return result;
    }
  }
};

/**
 * Unifies two types t1 and t2 within the given context.
 */
export const unify = (t1: BaseType, t2: BaseType, context: Context): void => {
  // If they are literally equal, we're done.
  if (typesLitEq(t1, t2)) return;

  // Handle universal types.
  if (t1.kind === 'forall' || t2.kind === 'forall') {
    if (t1.kind === 'forall' && t2.kind === 'forall') {
      // Alpha–rename t2 to t1's binder.
      // Replace all occurrences of t2's bound variable with t1's in t2.body.
      const t2RenamedBody = substituteType(
        t2.body,
        mkTypeVariable(t2.typeVar),
        mkTypeVariable(t1.typeVar)
      );
        // Now unify the bodies.
      unify(t1.body, t2RenamedBody, context);
      return;
    } else {
      // You cannot unify a universal type with a non–universal type.
      throw new TypeError(
        `cannot unify universal type ${prettyPrintTy(t1)} with non-universal type ${prettyPrintTy(t2)}`
      );
    }
  }

  // Handle type variables.
  if (t1.kind === 'type-var') {
    if (occursIn(t1, t2)) {
      throw new TypeError(
        `occurs check failed: ${t1.typeName} occurs in ${prettyPrintTy(t2)}`
      );
    }
    for (const [key, ty] of context.entries()) {
      context.set(key, substituteType(ty, t1, t2));
    }
    return;
  }

  if (t2.kind === 'type-var') {
    if (occursIn(t2, t1)) {
      throw new TypeError(
        `occurs check failed: ${t2.typeName} occurs in ${prettyPrintTy(t1)}`
      );
    }
    for (const [key, ty] of context.entries()) {
      context.set(key, substituteType(ty, t2, t1));
    }
    return;
  }

  // At this point, both t1 and t2 are non-terminal (arrow) types.
  // Ensure that both have lft and rgt.
  if ('lft' in t1 && 'lft' in t2) {
    unify(t1.lft, t2.lft, context);
    unify(t1.rgt, t2.rgt, context);
  } else {
    throw new TypeError(
      `cannot unify types: ${prettyPrintTy(t1)} and ${prettyPrintTy(t2)}`
    );
  }
};

/**
 * Attach the inferred types to the corresponding untyped lambda term,
 * producing a TypedLambda.
 */
const attachTypes = (untyped: UntypedLambda, types: Context): TypedLambda => {
  switch (untyped.kind) {
    case 'lambda-var':
      return untyped;
    case 'lambda-abs': {
      const ty = types.get(untyped.name);
      if (ty === undefined) {
        throw new TypeError('missing type for term: ' + untyped.name);
      }
      return mkTypedAbs(
        untyped.name,
        ty,
        attachTypes(untyped.body, types)
      );
    }
    case 'non-terminal':
      return cons(
        attachTypes(untyped.lft, types),
        attachTypes(untyped.rgt, types)
      );
  }
};

/**
 * Runs a simplified version of Algorithm W over the given untyped term.
 * Returns a pair of the typed term and its inferred type.
 */
export const inferType = (
  term: UntypedLambda
): [TypedLambda, BaseType] => {
  const absBindings = new Map<string, BaseType>();
  const inferredContext = new Map<string, BaseType>();
  let inferred = algorithmW(term, varSource(), absBindings, inferredContext);

  inferredContext.forEach((combinedTy, termName) => {
    const originalTy = absBindings.get(termName);
    if (originalTy !== undefined && !typesLitEq(combinedTy, originalTy)) {
      inferred = substituteType(inferred, originalTy, combinedTy);
    }
  });

  // Normalize both the context and the final inferred type.
  const normalizationMappings = new Map<string, string>();
  const vars = varSource();
  inferredContext.forEach((ty, termName) => {
    inferredContext.set(termName, normalizeTy(ty, normalizationMappings, vars));
  });
  const normalizedType = normalizeTy(inferred, normalizationMappings, vars);

  const typedTerm = attachTypes(term, inferredContext);
  return [typedTerm, normalizedType];
};
