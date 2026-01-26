/**
 * Untyped lambda calculus term representation and utilities.
 *
 * This module defines the AST types for untyped lambda calculus terms,
 * including variables, abstractions, and applications. It provides
 * pretty-printing and utility functions for working with untyped lambda terms.
 *
 * @module
 */

import {
  BACKSLASH,
  FAT_ARROW,
  LEFT_PAREN,
  RIGHT_PAREN,
} from "../parser/consts.ts";

/**
 * This is a single term variable with a name.
 *
 * For instance, in the expression "λx:a.y", this is just "y".
 */
export interface LambdaVar {
  kind: "lambda-var";
  name: string;
}

/**
 * Creates a lambda calculus variable term.
 * @param name the variable name
 * @returns a new lambda variable node
 */
export const mkVar = (name: string): LambdaVar => ({
  kind: "lambda-var",
  name,
});

/**
 * An untyped lambda abstraction (λx.body).
 * Represents a function that binds a variable name and has a body expression.
 */
interface UntypedLambdaAbs {
  kind: "lambda-abs";
  name: string;
  body: UntypedLambda;
}

/**
 * Creates an untyped lambda abstraction (λx.body).
 * @param name the bound variable name
 * @param body the body of the abstraction
 * @returns a new lambda abstraction node
 */
export const mkUntypedAbs = (
  name: string,
  body: UntypedLambda,
): UntypedLambda => ({
  kind: "lambda-abs",
  name,
  body,
});

/**
 * An application in the untyped lambda calculus
 */
export interface UntypedApplication {
  kind: "non-terminal";
  lft: UntypedLambda;
  rgt: UntypedLambda;
}

/**
 * The union type representing all possible untyped lambda calculus terms.
 * Includes variables, abstractions, and applications.
 */
export type UntypedLambda =
  | LambdaVar
  | UntypedLambdaAbs
  | UntypedApplication;

/**
 * Creates an application of one untyped lambda term to another.
 * @param left the function term
 * @param right the argument term
 * @returns a new application node
 */
export const createApplication = (
  left: UntypedLambda,
  right: UntypedLambda,
): UntypedLambda => ({
  kind: "non-terminal",
  lft: left,
  rgt: right,
});

/**
 * Creates a left-associative application chain from multiple untyped lambda terms.
 * For example, typelessApp(a, b, c) creates ((a b) c).
 * @param uts the untyped lambda terms to apply in sequence
 * @returns the resulting application chain
 */
export const typelessApp = (...uts: UntypedLambda[]) =>
  uts.reduce(createApplication);

/**
 * Pretty-prints an untyped lambda expression using ASCII syntax.
 * @param ut the untyped lambda term
 * @returns a human-readable string representation
 */
export const prettyPrintUntypedLambda = (ut: UntypedLambda): string => {
  switch (ut.kind) {
    case "lambda-var":
      return ut.name;
    case "lambda-abs":
      return `${BACKSLASH}${ut.name}${FAT_ARROW}${prettyPrintUntypedLambda(ut.body)}`;
    case "non-terminal":
      return `${LEFT_PAREN}${prettyPrintUntypedLambda(ut.lft)}` +
        ` ${prettyPrintUntypedLambda(ut.rgt)}${RIGHT_PAREN}`;
  }
};
