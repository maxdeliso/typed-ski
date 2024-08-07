import { ConsCell } from '../cons.ts';
import { LambdaVar } from '../lambda/lambda.ts';
import { Type, arrow, typesLitEq, prettyPrintTy } from './types.ts';

/**
 * This is a typed lambda abstraction, consisting of three parts.
 * 1. The variable name.
 * 2. The type.
 * 3. The body of the expression in the typed lambda calculus.
 *
 * This triplet is essentially an anonymous function which also includes
 * a type describing its input. The body also has a type, but it is not
 * captured in the type "ty," only the input to the function.
 *
 * For instance, in the expression "λx:a.y", the following parts are:
 * Variable name is x.
 * The type is a.
 * The body of the expression is y.
 */
export interface TypedLambdaAbs {
  kind: 'typed-lambda-abstraction',
  varName: string,
  ty: Type,
  body: TypedLambda
}

/**
 * This recursive type represents the legal terms of the typed lambda calculus.
 */
export type TypedLambda
  = LambdaVar
  | TypedLambdaAbs
  | ConsCell<TypedLambda>;

export const mkTypedAbs = (
  varName: string, ty: Type, body: TypedLambda
): TypedLambdaAbs => ({
  kind: 'typed-lambda-abstraction',
  varName,
  ty,
  body
});

/**
 * Γ, or capital Gamma, represents the set of mappings from names to types.
 */
export type Context = Map<string, Type>;

export const addBinding =
  (ctx: Context, name: string, ty: Type): Context => {
    if (ctx.get(name)) {
      throw new TypeError('duplicated binding for name: ' + name);
    }

    return ctx.set(name, ty);
  };

export const typecheck = (typedTerm: TypedLambda): Type => {
  return typecheckGiven(new Map<string, Type>(), typedTerm);
};

/**
 * Type checks terms in the simply typed lambda calculus.
 * Throws an Error if a valid type could not be deduced.
 *
 * @param ctx a set of bindings from names to types
 * @param typedTerm a lambda term annotated with an input type
 * @returns the type of the entire term
 */
export const typecheckGiven = (ctx: Context, typedTerm: TypedLambda): Type => {
  switch (typedTerm.kind) {
    case 'lambda-var': {
      const termName = typedTerm.name;
      const lookedUp = ctx.get(termName);

      if (lookedUp === undefined) {
        throw new TypeError('unknown term named: ' + termName);
      }

      return lookedUp;
    }
    case 'typed-lambda-abstraction': {
      const updatedCtx = addBinding(ctx, typedTerm.varName, typedTerm.ty);
      const bodyTy = typecheckGiven(updatedCtx, typedTerm.body);
      return arrow(typedTerm.ty, bodyTy);
    }
    case 'non-terminal': {
      const tyLft = typecheckGiven(ctx, typedTerm.lft);
      const tyRgt = typecheckGiven(ctx, typedTerm.rgt);

      if (tyLft.kind !== 'non-terminal') {
        throw new TypeError('arrow type expected on lhs');
      }

      const takes = tyLft.lft;
      const gives = tyLft.rgt;

      if (!typesLitEq(tyRgt, takes)) {
        throw new TypeError('type mismatch');
      }

      return gives;
    }
  }
};

export const prettyPrintTypedLambda = (expr: TypedLambda): string => {
  switch (expr.kind) {
    case 'lambda-var': {
      return expr.name;
    }
    case 'typed-lambda-abstraction': {
      return 'λ' +
        expr.varName +
        ':' +
        prettyPrintTy(expr.ty) +
        '.' +
        prettyPrintTypedLambda(expr.body);
    }
    case 'non-terminal': {
      return '(' +
        prettyPrintTypedLambda(expr.lft) +
        prettyPrintTypedLambda(expr.rgt) +
        ')';
    }
  }
};

export const typedTermsLitEq = (a: TypedLambda, b: TypedLambda): boolean => {
  if (a.kind === 'lambda-var' && b.kind === 'lambda-var') {
    return a.name === b.name;
  } else if (a.kind === 'typed-lambda-abstraction' &&
    b.kind === 'typed-lambda-abstraction') {
    return typesLitEq(a.ty, b.ty) &&
      a.varName === b.varName &&
      typedTermsLitEq(a.body, b.body);
  } else if (a.kind === 'non-terminal' && b.kind === 'non-terminal') {
    return typedTermsLitEq(a.lft, b.lft) && typedTermsLitEq(a.rgt, b.rgt);
  } else {
    return false;
  }
};
