import {
  arrow,
  BaseType,
  ForallType,
  prettyPrintTy,
  typesLitEq,
} from "./types.ts";
import { cons } from "../cons.ts";
import { SystemFTerm } from "../terms/systemF.ts";
import { mkTypedAbs, TypedLambda } from "./typedLambda.ts";
import {
  AVLTree,
  createEmptyAVL,
  insertAVL,
  searchAVL,
} from "../data/avl/avlNode.ts";
import { compareStrings } from "../data/map/stringMap.ts";
import { createSet, insertSet, Set } from "../data/set/set.ts";
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
    case "non-terminal":
      return cons(
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
    case "non-terminal":
      return referencesVar(original.lft, varName) ||
        referencesVar(original.rgt, varName);
    case "forall":
      return referencesVar(original.body, varName);
  }
};

/**
 * The type checking context for System F.
 * - termCtx maps term variables (strings) to their types (SystemFType) using a persistent AVL tree.
 * - typeVars is the set of bound type variables using our persistent AVLSet.
 */
export interface SystemFContext {
  termCtx: AVLTree<string, BaseType>;
  typeVars: Set<string>;
}

/**
 * Returns an empty System F context.
 */
export const emptySystemFContext = (): SystemFContext => ({
  termCtx: createEmptyAVL<string, BaseType>(),
  typeVars: createSet<string>(compareStrings),
});

/**
 * Typechecks a System F term.
 * Returns just the type (discarding the final context).
 */
export const typecheck = (term: SystemFTerm): BaseType => {
  return typecheckSystemF(emptySystemFContext(), term)[0];
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
      const ty = searchAVL(ctx.termCtx, term.name, compareStrings);
      if (ty === undefined) {
        throw new TypeError(`unknown variable: ${term.name}`);
      }
      return [ty, ctx];
    }
    case "systemF-abs": {
      // Extend the term context locally with x:T.
      const newTermCtx = insertAVL(
        ctx.termCtx,
        term.name,
        term.typeAnnotation,
        compareStrings,
      );
      const localCtx: SystemFContext = {
        termCtx: newTermCtx,
        typeVars: ctx.typeVars, // persistent: no need to copy
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
            prettyPrintTy(funTy)
          }`,
        );
      }
      if (!typesLitEq(funTy.lft, argTy)) {
        // Only use normalization for forall types (alpha-equivalence)
        if (funTy.lft.kind === "forall" && argTy.kind === "forall") {
          const normLft = normalize(funTy.lft);
          const normArg = normalize(argTy);
          if (!typesLitEq(normLft, normArg)) {
            throw new TypeError(
              `function argument type mismatch: expected ${
                prettyPrintTy(funTy.lft)
              }, got ${prettyPrintTy(argTy)}`,
            );
          }
        } else {
          throw new TypeError(
            `function argument type mismatch: expected ${
              prettyPrintTy(funTy.lft)
            }, got ${prettyPrintTy(argTy)}`,
          );
        }
      }
      return [funTy.rgt, ctxAfterRight];
    }
    case "systemF-type-abs": {
      // Extend the type variable context locally using our AVLSet.
      const localCtx: SystemFContext = {
        termCtx: ctx.termCtx,
        typeVars: insertSet(ctx.typeVars, term.typeVar),
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
            prettyPrintTy(funTy)
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
  }
};

/**
 * Pretty prints a System F type.
 */
export const prettyPrintSystemFType = (ty: BaseType): string => {
  if (ty.kind === "type-var") {
    return ty.typeName;
  }
  if (ty.kind === "non-terminal") {
    return `(${prettyPrintSystemFType(ty.lft)}→${
      prettyPrintSystemFType(ty.rgt)
    })`;
  }
  // Must be a forall type.
  return `(∀${ty.typeVar}.${prettyPrintSystemFType(ty.body)})`;
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
export const eraseSystemF = (term: SystemFTerm): TypedLambda => {
  switch (term.kind) {
    case "systemF-var":
      return { kind: "lambda-var", name: term.name };
    case "systemF-abs":
      return mkTypedAbs(
        term.name,
        term.typeAnnotation,
        eraseSystemF(term.body),
      );
    case "systemF-type-abs":
      return eraseSystemF(term.body);
    case "systemF-type-app":
      return eraseSystemF(term.term);
    default:
      return cons(
        eraseSystemF(term.lft),
        eraseSystemF(term.rgt),
      );
  }
};
