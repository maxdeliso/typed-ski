/**
 * Type inference using Algorithm W.
 *
 * This module implements Algorithm W for type inference in the simply typed
 * lambda calculus, including unification, constraint solving, and type
 * normalization.
 *
 * @module
 */
import {
  arrow,
  type BaseType,
  mkTypeVariable,
  prettyPrintTy,
  typesLitEq,
  type TypeVariable,
} from "./types.ts";
import { createTypedApplication } from "./typedLambda.ts";
import type { UntypedLambda } from "../terms/lambda.ts";
import {
  type Context,
  emptyContext,
  mkTypedAbs,
  type TypedLambda,
} from "./typedLambda.ts";
import { varSource } from "./varSource.ts";
import { normalizeTy } from "./normalization.ts";
import { insertAVL, keyValuePairs, searchAVL } from "../data/avl/avlNode.ts";
import { compareStrings, createStringMap } from "../data/map/stringMap.ts";

interface InferenceState {
  varBindings: Context;
  constraints: Context;
}

interface InferenceResult {
  type: BaseType;
  state: InferenceState;
}

/**
 * Checks whether the type variable tv occurs in ty.
 */
const occursIn = (tv: TypeVariable, ty: BaseType): boolean => {
  if (ty.kind === "type-var") {
    return ty.typeName === tv.typeName;
  } else if (ty.kind === "non-terminal") {
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
 * Substitutes all instances of `lft` with `rgt` in `original`.
 */
export const substituteType = (
  original: BaseType,
  lft: BaseType,
  rgt: BaseType,
): BaseType => {
  if (typesLitEq(lft, original)) {
    if (lft.kind === "type-var" && occursIn(lft, rgt)) {
      throw new TypeError(
        `occurs check failed: ${lft.typeName} occurs in ${prettyPrintTy(rgt)}`,
      );
    }
    return rgt;
  }
  switch (original.kind) {
    case "type-var":
      return original;
    case "non-terminal":
      return arrow(
        substituteType(original.lft, lft, rgt),
        substituteType(original.rgt, lft, rgt),
      );
    case "forall":
      // If the bound variable is the same as the pattern we wish to substitute,
      // do not substitute in the body (the binder shadows it).
      if (lft.kind === "type-var" && original.typeVar === lft.typeName) {
        return original;
      } else {
        return {
          kind: "forall",
          typeVar: original.typeVar,
          body: substituteType(original.body, lft, rgt),
        };
      }
  }
};

/**
 * The heart of Algorithm W.
 */
export const algorithmW = (
  term: UntypedLambda,
  nextVar: () => TypeVariable,
  state: InferenceState,
): InferenceResult => {
  switch (term.kind) {
    case "lambda-var": {
      const contextType = searchAVL(
        state.varBindings,
        term.name,
        compareStrings,
      );
      if (contextType !== undefined) {
        return {
          type: contextType,
          state,
        };
      } else {
        return {
          type: nextVar(),
          state,
        };
      }
    }
    case "lambda-abs": {
      const paramType = nextVar();
      const newState = {
        varBindings: insertAVL(
          state.varBindings,
          term.name,
          paramType,
          compareStrings,
        ),
        constraints: insertAVL(
          state.constraints,
          term.name,
          paramType,
          compareStrings,
        ),
      };

      const result = algorithmW(term.body, nextVar, newState);
      return {
        type: arrow(paramType, result.type),
        state: result.state,
      };
    }
    case "non-terminal": {
      const leftResult = algorithmW(term.lft, nextVar, state);
      const rightResult = algorithmW(term.rgt, nextVar, leftResult.state);
      const resultType = nextVar();
      const newConstraints = unify(
        leftResult.type,
        arrow(rightResult.type, resultType),
        rightResult.state.constraints,
      );

      return {
        type: resultType,
        state: {
          ...rightResult.state,
          constraints: newConstraints,
        },
      };
    }
  }
};

/**
 * Unifies two types t1 and t2 within the given context.
 */
export const unify = (
  t1: BaseType,
  t2: BaseType,
  context: Context,
): Context => {
  // If they are literally equal, we're done.
  if (typesLitEq(t1, t2)) return context;

  // Handle universal types.
  if (t1.kind === "forall" || t2.kind === "forall") {
    if (t1.kind === "forall" && t2.kind === "forall") {
      // Alpha–rename t2 to t1's binder.
      // Replace all occurrences of t2's bound variable with t1's in t2.body.
      const t2RenamedBody = substituteType(
        t2.body,
        mkTypeVariable(t2.typeVar),
        mkTypeVariable(t1.typeVar),
      );

      return unify(t1.body, t2RenamedBody, context);
    } else {
      // You cannot unify a universal type with a non–universal type.
      throw new TypeError(
        `cannot unify universal type ${
          prettyPrintTy(t1)
        } with non-universal type ${prettyPrintTy(t2)}`,
      );
    }
  }

  // Handle type variables.
  if (t1.kind === "type-var") {
    if (occursIn(t1, t2)) {
      throw new TypeError(
        `occurs check failed: ${t1.typeName} occurs in ${prettyPrintTy(t2)}`,
      );
    }
    for (const [key, ty] of keyValuePairs(context)) {
      context = insertAVL(
        context,
        key,
        substituteType(ty, t1, t2),
        compareStrings,
      );
    }
    context = insertAVL(context, t1.typeName, t2, compareStrings);
    return context;
  }

  if (t2.kind === "type-var") {
    if (occursIn(t2, t1)) {
      throw new TypeError(
        `occurs check failed: ${t2.typeName} occurs in ${prettyPrintTy(t1)}`,
      );
    }

    for (const [key, ty] of keyValuePairs(context)) {
      context = insertAVL(
        context,
        key,
        substituteType(ty, t2, t1),
        compareStrings,
      );
    }
    context = insertAVL(context, t2.typeName, t1, compareStrings);
    return context;
  }

  // At this point, both t1 and t2 are non-terminal (arrow) types.
  // Ensure that both have lft and rgt.
  if ("lft" in t1 && "lft" in t2) {
    const context1 = unify(t1.lft, t2.lft, context);
    return unify(t1.rgt, t2.rgt, context1);
  } else {
    throw new TypeError(
      `cannot unify types: ${prettyPrintTy(t1)} and ${prettyPrintTy(t2)}`,
    );
  }
};

/**
 * Attach the inferred types to the corresponding untyped lambda term,
 * producing a TypedLambda.
 */
const attachTypes = (untyped: UntypedLambda, types: Context): TypedLambda => {
  switch (untyped.kind) {
    case "lambda-var":
      return untyped;
    case "lambda-abs": {
      const ty = searchAVL(types, untyped.name, compareStrings);
      if (ty === undefined) {
        throw new TypeError("missing type for term: " + untyped.name);
      }
      return mkTypedAbs(
        untyped.name,
        ty,
        attachTypes(untyped.body, types),
      );
    }
    case "non-terminal":
      return createTypedApplication(
        attachTypes(untyped.lft, types),
        attachTypes(untyped.rgt, types),
      );
  }
};

/**
 * Runs a simplified version of Algorithm W over the given untyped term.
 * Returns a pair of the typed term and its inferred type.
 */
export const inferType = (
  term: UntypedLambda,
): [TypedLambda, BaseType] => {
  const initialState: InferenceState = {
    varBindings: emptyContext(),
    constraints: emptyContext(),
  };

  const result = algorithmW(term, varSource(), initialState);
  // eslint-disable-next-line prefer-const
  let { type, state } = result;

  // Apply substitutions from constraints to the type
  for (const [key, combinedTy] of keyValuePairs(state.constraints)) {
    const originalTy = searchAVL(state.varBindings, key, compareStrings);
    if (originalTy !== undefined && !typesLitEq(combinedTy, originalTy)) {
      type = substituteType(type, originalTy, combinedTy);
    }
  }

  // Normalize types
  let normalizationMappings = createStringMap();
  const vars = varSource();

  // Normalize context
  const normalizedContext = keyValuePairs(state.constraints).reduce(
    (ctx, [termName, ty]) => {
      const [nty, nvars] = normalizeTy(ty, normalizationMappings, vars);
      normalizationMappings = nvars;
      return insertAVL(ctx, termName, nty, compareStrings);
    },
    emptyContext(),
  );
  // Normalize final type
  const [normalizedType] = normalizeTy(type, normalizationMappings, vars);
  const typedTerm = attachTypes(term, normalizedContext);
  return [typedTerm, normalizedType];
};
