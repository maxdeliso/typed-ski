import { cons, type ConsCell } from "../cons.ts";

/**
 * This is a single term variable with a name.
 *
 * For instance, in the expression "λx:a.y", this is just "y".
 */
export interface LambdaVar {
  kind: "lambda-var";
  name: string;
}

export const mkVar = (name: string): LambdaVar => ({
  kind: "lambda-var",
  name,
});

// λx.<body>, where x is a name
interface UntypedLambdaAbs {
  kind: "lambda-abs";
  name: string;
  body: UntypedLambda;
}

export const mkUntypedAbs = (
  name: string,
  body: UntypedLambda,
): UntypedLambda => ({
  kind: "lambda-abs",
  name,
  body,
});

/**
 * The legal terms of the untyped lambda calculus.
 * e ::= x | λx.e | e e, where x is a variable name, and e is a valid expr
 */
export type UntypedLambda =
  | LambdaVar
  | UntypedLambdaAbs
  | ConsCell<UntypedLambda>;

export const typelessApp = (...uts: UntypedLambda[]) =>
  uts.reduce(cons<UntypedLambda>);

/**
 * Pretty-prints an untyped lambda expression using λ and parentheses.
 * @param ut the untyped lambda term
 * @returns a human-readable string representation
 */
export const prettyPrintUntypedLambda = (ut: UntypedLambda): string => {
  switch (ut.kind) {
    case "lambda-var":
      return ut.name;
    case "lambda-abs":
      return `λ${ut.name}.${prettyPrintUntypedLambda(ut.body)}`;
    case "non-terminal":
      return `(${prettyPrintUntypedLambda(ut.lft)}` +
        ` ${prettyPrintUntypedLambda(ut.rgt)})`;
  }
};
