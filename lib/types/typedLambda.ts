import { cons, ConsCell } from "../cons.ts";
import {
  AVLTree,
  createEmptyAVL,
  insertAVL,
  searchAVL,
} from "../data/avl/avlNode.ts";
import { compareStrings } from "../data/map/stringMap.ts";
import { LambdaVar, mkUntypedAbs, UntypedLambda } from "../terms/lambda.ts";
import { arrow, BaseType, prettyPrintTy, typesLitEq } from "./types.ts";

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
 * This recursive type represents the legal terms of the typed lambda calculus.
 */
export type TypedLambda =
  | LambdaVar
  | TypedLambdaAbs
  | ConsCell<TypedLambda>;

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
 * Γ, or capital Gamma, represents the set of mappings from names to types.
 */
export type Context = AVLTree<string, BaseType>;

/** Create an empty string->string AVL tree. */
export function emptyContext(): Context {
  return createEmptyAVL<string, BaseType>();
}

export const addBinding = (
  ctx: Context,
  name: string,
  ty: BaseType,
): Context => {
  if (searchAVL(ctx, name, compareStrings) !== undefined) {
    throw new TypeError("duplicated binding for name: " + name);
  }

  return insertAVL(ctx, name, ty, compareStrings);
};

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
      const lookedUp = searchAVL(ctx, termName, compareStrings);

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
  }
};

export const prettyPrintTypedLambda = (expr: TypedLambda): string => {
  switch (expr.kind) {
    case "lambda-var": {
      return expr.name;
    }
    case "typed-lambda-abstraction": {
      return "λ" +
        expr.varName +
        ":" +
        prettyPrintTy(expr.ty) +
        "." +
        prettyPrintTypedLambda(expr.body);
    }
    case "non-terminal": {
      return "(" +
        prettyPrintTypedLambda(expr.lft) +
        prettyPrintTypedLambda(expr.rgt) +
        ")";
    }
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
 * @param t The typechecked lambda expression to erase types from.
 * @returns An equivalent untyped lambda expression.
 */
export const eraseTypedLambda = (t: TypedLambda): UntypedLambda => {
  switch (t.kind) {
    case "lambda-var":
      return t;
    case "typed-lambda-abstraction":
      return mkUntypedAbs(t.varName, eraseTypedLambda(t.body));
    case "non-terminal":
      return cons(eraseTypedLambda(t.lft), eraseTypedLambda(t.rgt));
  }
};
