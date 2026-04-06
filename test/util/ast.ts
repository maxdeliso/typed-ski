import type { SystemFTerm } from "../../lib/terms/systemF.ts";
import type {
  TypedLambda,
  TypedLambdaAbs,
} from "../../lib/types/typedLambda.ts";
import type { BaseType } from "../../lib/types/types.ts";

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
export const createTypedApp = (
  left: TypedLambda,
  right: TypedLambda,
): TypedLambda => ({
  kind: "non-terminal",
  lft: left,
  rgt: right,
});
