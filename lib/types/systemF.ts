/**
 * System F type checking and utilities.
 *
 * This module provides type checking functionality for System F (polymorphic
 * lambda calculus) terms, including context management, type substitution,
 * and conversion to simply typed lambda calculus.
 *
 * @module
 */
import { arrow, type BaseType, type ForallType, typesLitEq } from "./types.ts";
import { unparseType } from "../parser/type.ts";
import {
  makeNatType,
  makeUntypedChurchNumeral,
  parseNatLiteralIdentifier,
} from "../consts/nat.ts";
import {
  createApplication,
  mkUntypedAbs,
  type UntypedLambda,
} from "../terms/lambda.ts";
import { mkSystemFAbs, type SystemFTerm } from "../terms/systemF.ts";
import { normalize } from "./normalization.ts";

/*
 * https://en.wikipedia.org/wiki/System_F
 */

export const forall = (typeVar: string, body: BaseType): ForallType => ({
  kind: "forall",
  typeVar,
  body,
});

/**
 * Substitute in the type "original" the sub–type lft with rgt.
 */
export const substituteSystemFType = (
  original: BaseType,
  targetVarName: string,
  replacement: BaseType,
): BaseType => {
  switch (original.kind) {
    case "type-var":
      return original.typeName === targetVarName ? replacement : original;
    case "type-app":
      return {
        kind: "type-app",
        fn: substituteSystemFType(original.fn, targetVarName, replacement),
        arg: substituteSystemFType(original.arg, targetVarName, replacement),
      };
    case "non-terminal":
      return arrow(
        substituteSystemFType(original.lft, targetVarName, replacement),
        substituteSystemFType(original.rgt, targetVarName, replacement),
      );
    case "forall":
      if (original.typeVar === targetVarName) {
        return original;
      }
      return {
        kind: "forall",
        typeVar: original.typeVar,
        body: substituteSystemFType(original.body, targetVarName, replacement),
      };
  }
};

export const referencesVar = (
  original: BaseType,
  varName: string,
): boolean => {
  switch (original.kind) {
    case "type-var":
      return original.typeName === varName;
    case "type-app":
      return referencesVar(original.fn, varName) ||
        referencesVar(original.arg, varName);
    case "non-terminal":
      return referencesVar(original.lft, varName) ||
        referencesVar(original.rgt, varName);
    case "forall":
      return referencesVar(original.body, varName);
  }
};

/**
 * The type checking context for System F.
 * - termCtx maps term variables (strings) to their types (SystemFType) using a Map.
 * - typeVars is the set of bound type variables using a Set.
 * - typeAliases maps type alias names to their definitions (optional, for resolving type variables).
 */
export interface SystemFContext {
  termCtx: Map<string, BaseType>;
  typeVars: Set<string>;
  typeAliases?: Map<string, BaseType>;
}

/**
 * Returns an empty System F context.
 */
export const emptySystemFContext = (
  typeAliases?: Map<string, BaseType>,
): SystemFContext => ({
  termCtx: new Map<string, BaseType>(),
  typeVars: new Set<string>(),
  typeAliases,
});

/**
 * Resolves a type variable to its definition if it's a type alias.
 * Returns the original type if it's not a type variable or has no alias definition.
 */
function resolveTypeAlias(
  ty: BaseType,
  typeAliases?: Map<string, BaseType>,
): BaseType {
  if (ty.kind === "type-var" && typeAliases?.has(ty.typeName)) {
    return typeAliases.get(ty.typeName)!;
  }
  return ty;
}

/**
 * Creates an application of one System F term to another.
 * @param left the function term
 * @param right the argument term
 * @returns a new application node
 */
export const createSystemFApplication = (
  left: SystemFTerm,
  right: SystemFTerm,
): SystemFTerm => ({
  kind: "non-terminal",
  lft: left,
  rgt: right,
});

/**
 * Expands systemF-let to App(Abs(x, typeOfValue, body), value) using the
 * type of value. Used before passes that expect no systemF-let (e.g. de Bruijn).
 */
export function reduceLets(
  ctx: SystemFContext,
  term: SystemFTerm,
): SystemFTerm {
  switch (term.kind) {
    case "systemF-let": {
      const reducedValue = reduceLets(ctx, term.value);
      const [typeOfValue] = typecheckSystemF(ctx, reducedValue);
      const reducedBody = reduceLets(ctx, term.body);
      return createSystemFApplication(
        mkSystemFAbs(term.name, typeOfValue, reducedBody),
        reducedValue,
      );
    }
    case "systemF-var":
      return term;
    case "systemF-abs":
      return mkSystemFAbs(
        term.name,
        term.typeAnnotation,
        reduceLets(ctx, term.body),
      );
    case "systemF-type-abs":
      return {
        kind: "systemF-type-abs",
        typeVar: term.typeVar,
        body: reduceLets(ctx, term.body),
      };
    case "systemF-type-app":
      return {
        kind: "systemF-type-app",
        term: reduceLets(ctx, term.term),
        typeArg: term.typeArg,
      };
    case "non-terminal":
      return createSystemFApplication(
        reduceLets(ctx, term.lft),
        reduceLets(ctx, term.rgt),
      );
    case "systemF-match":
      return {
        kind: "systemF-match",
        scrutinee: reduceLets(ctx, term.scrutinee),
        returnType: term.returnType,
        arms: term.arms.map((arm) => ({
          ...arm,
          body: reduceLets(ctx, arm.body),
        })),
      };
  }
}

/**
 * Typechecks a System F term.
 * Returns just the type (discarding the final context).
 */
export const typecheck = (term: SystemFTerm): BaseType => {
  return typecheckSystemF(emptySystemFContext(undefined), term)[0];
};

/**
 * Typechecks a System F term under the given context.
 * Returns a tuple of [type, updatedContext] so that context mutations propagate
 * to subsequent recursive invocations.
 *
 * Rules:
 * - For a variable, look up its type.
 * - For a term abstraction (λx:T. t): extend the context with x:T when typechecking t,
 *   then return arrow(T, U) while discarding the local binding.
 * - For a type abstraction (ΛX. t): extend the type variable context when typechecking t,
 *   then return ∀X. U while discarding the local type variable.
 * - For a term application (t u): typecheck t, then typecheck u with the updated context
 *   from t, ensuring t's type is an arrow type whose input matches u's type.
 * - For a type application (t [T]): typecheck t and substitute T for the bound type variable.
 */
export const typecheckSystemF = (
  ctx: SystemFContext,
  term: SystemFTerm,
): [BaseType, SystemFContext] => {
  switch (term.kind) {
    case "systemF-var": {
      const literalValue = parseNatLiteralIdentifier(term.name);
      if (literalValue !== null) {
        const natType = makeNatType();
        // Resolve type variable to type alias definition if available
        return [resolveTypeAlias(natType, ctx.typeAliases), ctx];
      }
      const ty = ctx.termCtx.get(term.name);
      if (ty === undefined) {
        throw new TypeError(`unknown variable: ${term.name}`);
      }
      return [resolveTypeAlias(ty, ctx.typeAliases), ctx];
    }
    case "systemF-abs": {
      // Extend the term context locally with x:T.
      const newTermCtx = new Map(ctx.termCtx);
      newTermCtx.set(term.name, term.typeAnnotation);
      const localCtx: SystemFContext = {
        termCtx: newTermCtx,
        typeVars: ctx.typeVars, // persistent: no need to copy
        typeAliases: ctx.typeAliases, // preserve type aliases
      };
      const [bodyTy] = typecheckSystemF(localCtx, term.body);
      // The local binding for x is scoped; we return the parent context.
      return [arrow(term.typeAnnotation, bodyTy), ctx];
    }
    case "non-terminal": {
      // Sequentially propagate context updates.
      const [funTy, ctxAfterLeft] = typecheckSystemF(ctx, term.lft);
      const [argTy, ctxAfterRight] = typecheckSystemF(ctxAfterLeft, term.rgt);
      if (funTy.kind !== "non-terminal") {
        throw new TypeError(
          `expected an arrow type in function application, but got: ${
            unparseType(funTy)
          }`,
        );
      }
      // Resolve type aliases before comparison
      const resolvedLft = resolveTypeAlias(funTy.lft, ctxAfterLeft.typeAliases);
      const resolvedArg = resolveTypeAlias(argTy, ctxAfterRight.typeAliases);

      if (!typesLitEq(resolvedLft, resolvedArg)) {
        // Only use normalization for forall types (alpha-equivalence)
        if (resolvedLft.kind === "forall" && resolvedArg.kind === "forall") {
          const normLft = normalize(resolvedLft);
          const normArg = normalize(resolvedArg);
          if (!typesLitEq(normLft, normArg)) {
            throw new TypeError(
              `function argument type mismatch: expected ${
                unparseType(funTy.lft)
              }, got ${unparseType(argTy)}`,
            );
          }
        } else {
          throw new TypeError(
            `function argument type mismatch: expected ${
              unparseType(funTy.lft)
            }, got ${unparseType(argTy)}`,
          );
        }
      }
      return [funTy.rgt, ctxAfterRight];
    }
    case "systemF-type-abs": {
      // Extend the type variable context locally using a Set.
      const newTypeVars = new Set(ctx.typeVars);
      newTypeVars.add(term.typeVar);
      const localCtx: SystemFContext = {
        termCtx: ctx.termCtx,
        typeVars: newTypeVars,
        typeAliases: ctx.typeAliases, // preserve type aliases
      };
      const [bodyTy] = typecheckSystemF(localCtx, term.body);
      // The local type variable binding is scoped; return the parent context.
      return [forall(term.typeVar, bodyTy), ctx];
    }
    case "systemF-type-app": {
      const [funTy, updatedCtx] = typecheckSystemF(ctx, term.term);
      if (funTy.kind !== "forall") {
        throw new TypeError(
          `type application expected a universal type, but got: ${
            unparseType(funTy)
          }`,
        );
      }
      const resultType = substituteSystemFType(
        funTy.body,
        funTy.typeVar,
        term.typeArg,
      );
      return [resultType, updatedCtx];
    }
    case "systemF-match":
      throw new TypeError("match must be elaborated before typechecking");
    case "systemF-let": {
      const [typeOfValue] = typecheckSystemF(ctx, term.value);
      const newTermCtx = new Map(ctx.termCtx);
      newTermCtx.set(term.name, typeOfValue);
      const [bodyTy] = typecheckSystemF(
        { termCtx: newTermCtx, typeVars: ctx.typeVars },
        term.body,
      );
      return [bodyTy, ctx];
    }
  }
};

/**
 * Transforms a well–typed System F term into a simply typed lambda term.
 *
 * The conversion proceeds as follows:
 * - A System F variable (systemF-var) becomes a lambda variable.
 * - A term abstraction (systemF-abs) is translated to a typed lambda abstraction,
 *   preserving the annotation.
 * - A type abstraction (systemF-type-abs) is dropped (erased) and the conversion
 *   continues with its body.
 * - A type application (systemF-type-app) is likewise dropped.
 * - A term application (represented as a cons cell, i.e. a "non-terminal")
 *   is recursively converted.
 *
 * @param term A System F term.
 * @returns An equivalent term in the simply typed lambda calculus.
 */
export const eraseSystemF = (term: SystemFTerm): UntypedLambda => {
  switch (term.kind) {
    case "systemF-var": {
      const literalValue = parseNatLiteralIdentifier(term.name);
      if (literalValue !== null) {
        return makeUntypedChurchNumeral(literalValue);
      }
      return { kind: "lambda-var", name: term.name };
    }
    case "systemF-abs":
      return mkUntypedAbs(
        term.name,
        eraseSystemF(term.body),
      );
    case "systemF-type-abs":
      return eraseSystemF(term.body);
    case "systemF-type-app":
      return eraseSystemF(term.term);
    case "systemF-match":
      throw new TypeError("match must be elaborated before erasure");
    case "systemF-let":
      return createApplication(
        mkUntypedAbs(term.name, eraseSystemF(term.body)),
        eraseSystemF(term.value),
      );
    default:
      return createApplication(
        eraseSystemF(term.lft),
        eraseSystemF(term.rgt),
      );
  }
};
