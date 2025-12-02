/**
 * Helpers for constructing typed lambda terms representing Church numerals.
 *
 * Typed lambda literals for natural numbers are desugared into fully expanded
 * lambda/application trees so the rest of the pipeline does not need a special
 * AST node. We reuse the existing untyped Church numeral generator and then run
 * type inference to attach the necessary annotations for each abstraction.
 */
import type { TypedLambda } from "./typedLambda.ts";
import { makeUntypedChurchNumeral } from "../consts/nat.ts";
import { inferType } from "./inference.ts";

/**
 * Builds the typed lambda encoding of a Church numeral.
 * @param value the non–negative integer to encode
 * @returns a simply typed lambda expression equivalent to the numeral
 */
export const makeTypedChurchNumeral = (value: bigint): TypedLambda => {
  if (value < 0n) {
    throw new RangeError("Nat literals must be non-negative");
  }

  const untyped = makeUntypedChurchNumeral(value);
  const [typed] = inferType(untyped);
  return typed;
};
