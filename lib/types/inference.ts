import { cons } from '../cons.ts';
import { Type, arrow, typesLitEq, prettyPrintTy, TypeVariable } from './types.ts';
import { UntypedLambda } from '../terms/lambda.ts';
import { TypedLambda, mkTypedAbs, Context } from './typedLambda.ts';
import { varSource } from './varSource.ts';
import { normalizeTy } from './normalization.ts';

/**
 * Checks whether the type variable tv occurs in ty.
 */
const occursIn = (tv: TypeVariable, ty: Type): boolean => {
  if (ty.kind === 'type-var') {
    return ty.typeName === tv.typeName;
  } else {
    return occursIn(tv, ty.lft) || occursIn(tv, ty.rgt);
  }
};

/**
 * Substitute in the type “original” the sub–type lft with rgt.
 */
export const substituteType = (original: Type, lft: Type, rgt: Type): Type => {
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
): Type => {
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
export const unify = (t1: Type, t2: Type, context: Context): void => {
  if (typesLitEq(t1, t2)) return;

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

  unify(t1.lft, t2.lft, context);
  unify(t1.rgt, t2.rgt, context);
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
): [TypedLambda, Type] => {
  const absBindings = new Map<string, Type>();
  const inferredContext = new Map<string, Type>();
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
