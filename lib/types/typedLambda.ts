/**
 * Simply typed lambda calculus representation and type checking.
 *
 * This module defines the AST types for simply typed lambda calculus terms
 * and provides type checking, pretty printing, and type erasure functionality.
 *
 * @module
 */
import { mkUntypedAbs } from "../terms/lambda.ts";
import type { UntypedLambda } from "../terms/lambda.ts";
import { unparseType } from "../parser/type.ts";
import { TypeError } from "./typeError.ts";
import { typesLitEq } from "./types.ts";
import type { BaseType } from "./types.ts";

/**
 * A term variable in the typed lambda calculus.
 */
interface TypedLambdaVar {
  kind: "lambda-var";
  name: string;
}

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
 * An application in the typed lambda calculus.
 */
interface TypedLambdaApplication {
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
 * A typed lambda term can be one of:
 * 1. A variable (TypedLambdaVar)
 * 2. An abstraction (TypedLambdaAbs)
 * 3. An application (TypedLambdaApplication)
 */
export type TypedLambda =
  | TypedLambdaVar
  | TypedLambdaAbs
  | TypedLambdaApplication;

/**
 * A context is a mapping from variable names to their types.
 */
export type Context = Map<string, BaseType>;

/**
 * Create an empty context.
 */
export const emptyContext = (): Context => new Map();

/**
 * Add a binding to a context.
 */
export const addBinding = (
  ctx: Context,
  name: string,
  ty: BaseType,
): Context => {
  const newCtx = new Map(ctx);
  if (newCtx.has(name)) {
    throw new TypeError(`variable ${name} already bound in context`);
  }
  newCtx.set(name, ty);
  return newCtx;
};

/**
 * Typechecks a typed lambda expression.
 *
 * This function performs type inference and checking on a typed lambda term.
 * It ensures that all variables are bound and that all function applications
 * are between compatible types.
 *
 * @param t The typed lambda term to check
 * @param ctx The context containing variable type assignments
 * @returns The type of the expression if it is well-typed
 * @throws TypeError if the expression is not well-typed
 */
export const typecheckTypedLambda = (
  t: TypedLambda,
  ctx: Context = emptyContext(),
): BaseType => {
  switch (t.kind) {
    case "lambda-var": {
      const ty = ctx.get(t.name);
      if (ty === undefined) {
        throw new TypeError(`unbound variable ${t.name}`);
      }
      return ty;
    }
    case "typed-lambda-abstraction": {
      const newCtx = addBinding(ctx, t.varName, t.ty);
      return {
        kind: "non-terminal",
        lft: t.ty,
        rgt: typecheckTypedLambda(t.body, newCtx),
      };
    }
    case "non-terminal": {
      const tyLft = typecheckTypedLambda(t.lft, ctx);
      const tyRgt = typecheckTypedLambda(t.rgt, ctx);

      if (tyLft.kind !== "non-terminal") {
        throw new TypeError("arrow type expected on lhs");
      }

      const takes = tyLft.lft;
      const gives = tyLft.rgt;

      if (!typesLitEq(tyRgt, takes)) {
        throw new TypeError(
          "Type mismatch in function application:\n" +
            `Expected: ${unparseType(takes)}\n` +
            `Got: ${unparseType(tyRgt)}`,
        );
      }

      return gives;
    }
    default:
      throw new TypeError("Unknown term kind");
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
      return {
        kind: "non-terminal",
        lft: eraseTypedLambda(t.lft),
        rgt: eraseTypedLambda(t.rgt),
      };
    default:
      throw new Error("Unknown term kind");
  }
};
