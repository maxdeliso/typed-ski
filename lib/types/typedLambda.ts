/**
 * Simply typed lambda calculus representation and type checking.
 *
 * This module defines the AST types for simply typed lambda calculus terms
 * and provides type checking, pretty printing, and type erasure functionality.
 *
 * @module
 */
import { arrow, type BaseType, prettyPrintTy, typesLitEq } from "./types.ts";
import {
  createApplication,
  type LambdaVar,
  mkUntypedAbs,
  type UntypedLambda,
} from "../terms/lambda.ts";
import {
  BACKSLASH,
  COLON,
  FAT_ARROW,
  LEFT_PAREN,
  RIGHT_PAREN,
} from "../parser/consts.ts";

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
  kind: "typed-lambda-abstraction";
  varName: string;
  ty: BaseType;
  body: TypedLambda;
}

/**
 * This recursive type represents the legal terms of the simply typed lambda calculus.
 *
 * Simply typed lambda calculus extends the untyped lambda calculus with explicit
 * type annotations. Every abstraction must specify the type of its parameter,
 * and type checking ensures that applications are well-typed.
 *
 * A TypedLambda can be:
 * - a variable (LambdaVar),
 * - a typed abstraction λx:T.t (TypedLambdaAbs)
 * - an application t u (TypedLambdaApplication)
 */
export type TypedLambda =
  | LambdaVar
  | TypedLambdaAbs
  | TypedLambdaApplication;

/**
 * An application in the typed lambda calculus
 */
export interface TypedLambdaApplication {
  kind: "non-terminal";
  lft: TypedLambda;
  rgt: TypedLambda;
}

export const mkTypedAbs = (
  varName: string,
  ty: BaseType,
  body: TypedLambda,
): TypedLambdaAbs => ({
  kind: "typed-lambda-abstraction",
  varName,
  ty,
  body,
});

/**
 * Creates an application of one typed lambda term to another.
 * @param left the function term
 * @param right the argument term
 * @returns a new application node
 */
export const createTypedApplication = (
  left: TypedLambda,
  right: TypedLambda,
): TypedLambda => ({
  kind: "non-terminal",
  lft: left,
  rgt: right,
});

/**
 * Γ, or capital Gamma, represents the set of mappings from names to types.
 */
export type Context = Map<string, BaseType>;

/** Create an empty context. */
export function emptyContext(): Context {
  return new Map<string, BaseType>();
}

export const addBinding = (
  ctx: Context,
  name: string,
  ty: BaseType,
): Context => {
  if (ctx.has(name)) {
    throw new TypeError("duplicated binding for name: " + name);
  }

  const newCtx = new Map(ctx);
  newCtx.set(name, ty);
  return newCtx;
};

/**
 * Infers the type of a simply typed lambda calculus term under an empty context.
 * @param typedTerm a typed lambda term
 * @returns the inferred base type
 * @throws TypeError if the term is ill-typed
 */
export const typecheckTypedLambda = (typedTerm: TypedLambda): BaseType => {
  return typecheckGiven(emptyContext(), typedTerm);
};

/**
 * Type checks terms in the simply typed lambda calculus.
 * Throws an Error if a valid type could not be deduced.
 *
 * @param ctx a set of bindings from names to types
 * @param typedTerm a lambda term annotated with an input type
 * @returns the type of the entire term
 */
export const typecheckGiven = (
  ctx: Context,
  typedTerm: TypedLambda,
): BaseType => {
  switch (typedTerm.kind) {
    case "lambda-var": {
      const termName = typedTerm.name;
      const lookedUp = ctx.get(termName);

      if (lookedUp === undefined) {
        throw new TypeError("unknown term named: " + termName);
      }

      return lookedUp;
    }
    case "typed-lambda-abstraction": {
      const updatedCtx = addBinding(ctx, typedTerm.varName, typedTerm.ty);
      const bodyTy = typecheckGiven(updatedCtx, typedTerm.body);
      return arrow(typedTerm.ty, bodyTy);
    }
    case "non-terminal": {
      const tyLft = typecheckGiven(ctx, typedTerm.lft);
      const tyRgt = typecheckGiven(ctx, typedTerm.rgt);

      if (tyLft.kind !== "non-terminal") {
        throw new TypeError("arrow type expected on lhs");
      }

      const takes = tyLft.lft;
      const gives = tyLft.rgt;

      if (!typesLitEq(tyRgt, takes)) {
        throw new TypeError(
          "Type mismatch in function application:\n" +
            `Expected: ${prettyPrintTy(takes)}\n` +
            `Got: ${prettyPrintTy(tyRgt)}`,
        );
      }

      return gives;
    }
    default:
      throw new TypeError("Unknown term kind");
  }
};

/**
 * Pretty-prints a simply typed lambda expression using ASCII syntax.
 *
 * Formats variables, abstractions, and applications using λ, colon-annotated types, and parentheses.
 * @param expr the typed lambda term
 * @returns a human-readable string representation
 */
export const prettyPrintTypedLambda = (expr: TypedLambda): string => {
  switch (expr.kind) {
    case "lambda-var": {
      return expr.name;
    }
    case "typed-lambda-abstraction": {
      return BACKSLASH +
        expr.varName +
        COLON +
        prettyPrintTy(expr.ty) +
        FAT_ARROW +
        prettyPrintTypedLambda(expr.body);
    }
    case "non-terminal": {
      return LEFT_PAREN +
        prettyPrintTypedLambda(expr.lft) +
        prettyPrintTypedLambda(expr.rgt) +
        RIGHT_PAREN;
    }
    default:
      throw new Error("Unknown term kind");
  }
};

export const typedTermsLitEq = (a: TypedLambda, b: TypedLambda): boolean => {
  if (a.kind === "lambda-var" && b.kind === "lambda-var") {
    return a.name === b.name;
  } else if (
    a.kind === "typed-lambda-abstraction" &&
    b.kind === "typed-lambda-abstraction"
  ) {
    return typesLitEq(a.ty, b.ty) && a.varName === b.varName &&
      typedTermsLitEq(a.body, b.body);
  } else if (a.kind === "non-terminal" && b.kind === "non-terminal") {
    return typedTermsLitEq(a.lft, b.lft) && typedTermsLitEq(a.rgt, b.rgt);
  } else {
    return false;
  }
};

/**
 * Erases type annotations from a simply typed lambda expression.
 *
 * This function converts a typed lambda term into an untyped lambda term by
 * removing all type annotations while preserving the structure of the expression.
 * Variables remain variables, abstractions remain abstractions (without type
 * annotations), and applications remain applications.
 *
 * @param t The typechecked lambda expression to erase types from
 * @returns An equivalent untyped lambda expression
 */
export const eraseTypedLambda = (t: TypedLambda): UntypedLambda => {
  switch (t.kind) {
    case "lambda-var":
      return t;
    case "typed-lambda-abstraction":
      return mkUntypedAbs(t.varName, eraseTypedLambda(t.body));
    case "non-terminal":
      return createApplication(
        eraseTypedLambda(t.lft),
        eraseTypedLambda(t.rgt),
      );
    default:
      throw new Error("Unknown term kind");
  }
};
