import type { UntypedLambda } from "../../lib/terms/lambda.ts";
import { createApplication } from "../../lib/terms/lambda.ts";
import type { SystemFTerm } from "../../lib/terms/systemF.ts";
import type {
  TypedLambda,
  TypedLambdaAbs,
} from "../../lib/types/typedLambda.ts";
import { typesLitEq } from "../../lib/types/types.ts";
import type { BaseType } from "../../lib/types/types.ts";

/**
 * Creates a left-associative application chain from multiple untyped lambda terms.
 * For example, typelessApp(a, b, c) creates ((a b) c).
 */
export const typelessApp = (...uts: UntypedLambda[]): UntypedLambda =>
  uts.reduce(createApplication);

/**
 * Creates a System F term application (t u).
 */
export const mkSystemFApp = (
  lft: SystemFTerm,
  rgt: SystemFTerm,
): SystemFTerm => ({ kind: "non-terminal", lft, rgt });

/**
 * Creates a typed lambda abstraction.
 */
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
 * Checks if two typed lambda terms are literally equal.
 */
export const typedTermsLitEq = (a: TypedLambda, b: TypedLambda): boolean => {
  if (a.kind === "lambda-var" && b.kind === "lambda-var") {
    return a.name === b.name;
  } else if (
    a.kind === "typed-lambda-abstraction" &&
    b.kind === "typed-lambda-abstraction"
  ) {
    return (
      typesLitEq(a.ty, b.ty) &&
      a.varName === b.varName &&
      typedTermsLitEq(a.body, b.body)
    );
  } else if (a.kind === "non-terminal" && b.kind === "non-terminal") {
    return typedTermsLitEq(a.lft, b.lft) && typedTermsLitEq(a.rgt, b.rgt);
  } else {
    return false;
  }
};
