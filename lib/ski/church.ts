/**
 * Church encoding utilities for SKI expressions.
 *
 * This module provides functionality for working with Church encodings of
 * numbers and booleans in SKI combinator expressions, including conversion
 * to and from JavaScript values.
 *
 * @module
 */
import { False, One, Succ, True, Zero } from "../consts/combinators.ts";
import { apply, applyMany, type SKIExpression } from "./expression.ts";
import { symbolicEvaluator } from "../evaluator/skiEvaluator.ts";
import { unChurchNumber as unChurchNumberNative } from "./native.ts";

/**
 * @see https://en.wikipedia.org/wiki/Church_encoding
 * @param n a number
 * @returns an extensionally equivalent Church numeral.
 */
export const ChurchN = (n: number): SKIExpression => {
  if (!Number.isInteger(n)) {
    throw new Error("ChurchN only accepts integers");
  }
  if (n < 0) {
    throw new Error("only non-negative integers are supported");
  } else if (n === 0) {
    return Zero;
  } else if (n === 1) {
    return One;
  } else {
    return apply(Succ, ChurchN(n - 1));
  }
};

/**
 * Evaluates a Church numeral SKI expression to a JavaScript number using the optimized native path.
 *
 * Useful for testing numeric results of SKI computations via Church encoding.
 */
export const UnChurchNumber = (exp: SKIExpression): number => {
  return unChurchNumberNative(exp);
};

/**
 * UnChurchBoolean applies the Church boolean expression (which is expected to be in normal form)
 * to two Church numerals (here ChurchN(1) and ChurchN(0)) and then uses UnChurch to obtain a number.
 * If the result is 1, then the Church boolean was true; if 0, then it was false.
 */
export const UnChurchBoolean = (expr: SKIExpression): boolean => {
  // Apply the Church boolean to ChurchN(1) (for true) and ChurchN(0) (for false)
  const testExpr = symbolicEvaluator.reduce(
    applyMany(expr, ChurchN(1), ChurchN(0)),
  );
  return UnChurchNumber(testExpr) === 1;
};

export const ChurchB = (b: boolean): SKIExpression => b ? True : False;
