import { BaseType, arrow, prettyPrintTy, typesLitEq, ForallType } from './types.js';
import { cons } from '../cons.js';
import { SystemFTerm } from '../terms/systemF.js';
import { TypedLambda, mkTypedAbs } from './typedLambda.js';

/*
 * https://en.wikipedia.org/wiki/System_F
 */

export type SystemFType = BaseType;

export const forall = (typeVar: string, body: SystemFType): ForallType => ({
  kind: 'forall',
  typeVar,
  body,
});

/**
 * Substitute in the type “original” the sub–type lft with rgt.
 */
export const substituteSystemFType = (
  original: SystemFType,
  targetVarName: string,
  replacement: SystemFType
): SystemFType => {
  if (original.kind === 'type-var') {
    return original.typeName === targetVarName ? replacement : original;
  }
  if ('lft' in original && 'rgt' in original) {
    return cons(
      substituteSystemFType(original.lft, targetVarName, replacement),
      substituteSystemFType(original.rgt, targetVarName, replacement)
    );
  }

  if (original.typeVar === targetVarName) {
    return original;
  } else {
    return {
      kind: 'forall',
      typeVar: original.typeVar,
      body: substituteSystemFType(original.body, targetVarName, replacement)
    };
  }
};

/**
 * The type checking context for System F.
 * termCtx maps term variables to their types.
 * typeVars is the set of bound type variables.
 */
export interface SystemFContext {
  termCtx: Map<string, SystemFType>;
  typeVars: Set<string>;
}

/**
 * Returns an empty System F context.
 */
export const emptySystemFContext = (): SystemFContext => ({
  termCtx: new Map<string, SystemFType>(),
  typeVars: new Set<string>()
});

/**
 * Typechecks a System F term.
 * Returns the type of the term.
 */
export const typecheck = (term: SystemFTerm): SystemFType => {
  return typecheckSystemF(emptySystemFContext(), term);
};

/**
 * Typechecks a System F term under the given context.
 * Returns the type of the term.
 *
 * Rules:
 * - For a variable, look up its type.
 * - For a term abstraction: if term is λx:T. t, then typecheck t under the
 *   context extended with x:T and return arrow(T, U).
 * - For a type abstraction: if term is ΛX. t, then extend the type variable context
 *   and return the universal type ∀X. U.
 * - For a term application: if term is t u, then typecheck t to get an arrow type T→U,
 *   typecheck u, and ensure its type matches T.
 * - For a type application: if term is t [T], then typecheck t which should yield
 *   a universal type ∀X. U; then substitute T for X in U.
 */
export const typecheckSystemF = (
  ctx: SystemFContext,
  term: SystemFTerm
): SystemFType => {
  switch (term.kind) {
    case 'systemF-var': {
      const ty = ctx.termCtx.get(term.name);
      if (!ty) {
        throw new TypeError(`unknown variable: ${term.name}`);
      }
      return ty;
    }
    case 'systemF-abs': {
      // The annotation must be a well–formed SystemFType.
      const newCtx: SystemFContext = {
        termCtx: new Map(ctx.termCtx),
        typeVars: new Set(ctx.typeVars)
      };
      newCtx.termCtx.set(term.name, term.typeAnnotation);
      const bodyTy = typecheckSystemF(newCtx, term.body);
      return arrow(term.typeAnnotation, bodyTy);
    }
    case 'non-terminal': {
      const funTy = typecheckSystemF(ctx, term.lft);
      const argTy = typecheckSystemF(ctx, term.rgt);
      // funTy must be an arrow type. We check by pattern matching.
      if (funTy.kind !== 'non-terminal') {
        throw new TypeError(`expected an arrow type in function application, but got: ${prettyPrintTy(funTy)}`);
      }
      // The input part of funTy must equal argTy.
      if (!typesLitEq(funTy.lft, argTy)) {
        throw new TypeError(
          `function argument type mismatch: expected ${prettyPrintTy(funTy.lft)}, got ${prettyPrintTy(argTy)}`
        );
      }
      return funTy.rgt;
    }
    case 'systemF-type-abs': {
      // Extend the type variable context.
      const newCtx: SystemFContext = {
        termCtx: new Map(ctx.termCtx),
        typeVars: new Set(ctx.typeVars)
      };
      newCtx.typeVars.add(term.typeVar);
      const bodyTy = typecheckSystemF(newCtx, term.body);
      return forall(term.typeVar, bodyTy);
    }
    case 'systemF-type-app': {
      const funTy = typecheckSystemF(ctx, term.term);
      // funTy must be a universal type.
      if (funTy.kind !== 'forall') {
        throw new TypeError(
          `type application expected a universal type, but got: ${prettyPrintTy(funTy)}`
        );
      }
      // It is natural to check that the type argument is well formed.
      // (We assume here that any type is well formed provided it is built from our shared constructs.)
      // Substitute term.funTy.typeVar with term.typeArg in funTy.body.
      return substituteSystemFType(funTy.body, funTy.typeVar, term.typeArg);
    }
  }
};

export const prettyPrintSystemFType = (ty: SystemFType): string => {
  if (ty.kind === 'type-var') {
    return ty.typeName;
  }
  if (ty.kind === 'non-terminal') {
    return `(${prettyPrintSystemFType(ty.lft)}→${prettyPrintSystemFType(ty.rgt)})`;
  }
  // Must be forall type
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
    case 'systemF-var':
      // Convert a System F variable to a lambda variable.
      return { kind: 'lambda-var', name: term.name };
    case 'systemF-abs':
      // Convert a term abstraction to a typed lambda abstraction.
      return mkTypedAbs(
        term.name,
        term.typeAnnotation,
        eraseSystemF(term.body)
      );
    case 'systemF-type-abs':
      // Erase the type abstraction by converting its body.
      return eraseSystemF(term.body);
    case 'systemF-type-app':
      // Erase the type application by converting the term part.
      return eraseSystemF(term.term);
    default:
      return cons(
        eraseSystemF(term.lft),
        eraseSystemF(term.rgt)
      );
  }
};
