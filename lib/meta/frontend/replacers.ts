import type { SystemFTerm } from "../../terms/systemF.ts";
import type { TypedLambda } from "../../types/typedLambda.ts";
import type { UntypedLambda } from "../../terms/lambda.ts";
import type { TripLangTerm } from "../trip.ts";
import { substituteSystemFType } from "../../types/systemF.ts";
import type { BaseType } from "../../types/types.ts";

export const replace = <T extends SystemFTerm | TypedLambda | UntypedLambda>(
  n: T,
  term: TripLangTerm,
): T => {
  if (n.kind === "systemF-var" && term.kind === "poly") {
    return term.term as T;
  }
  if (n.kind === "lambda-var" && term.kind === "typed") {
    return term.term as T;
  }
  if (term.kind === "untyped") {
    return term.term as T;
  }
  return n;
};

export function typedTypeReplace(
  n: TypedLambda,
  typeRef: string,
  targetBase: BaseType,
): TypedLambda {
  if (n.kind !== "typed-lambda-abstraction") {
    return n;
  }
  const newTy = substituteSystemFType(n.ty, typeRef, targetBase);
  return {
    ...n,
    ty: newTy,
  };
}
