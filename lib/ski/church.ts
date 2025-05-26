import { Zero, One, Succ, True, False } from '../consts/combinators.js';
import { apply, SKIExpression } from './expression.js';
import { symbolicEvaluator } from '../evaluator/skiEvaluator.js';
import { unChurchNumber as unChurchNumberNative } from './native.js';

/**
 * @see https://en.wikipedia.org/wiki/Church_encoding
 * @param n a number
 * @returns an extensionally equivalent Church numeral.
 */
export const ChurchN = (n: number): SKIExpression => {
  if (!Number.isInteger(n)) {
    throw new Error('ChurchN only accepts integers');
  }
  if (n < 0) {
    throw new Error('only non-negative integers are supported');
  } else if (n === 0) {
    return Zero;
  } else if (n === 1) {
    return One;
  } else {
    return apply(Succ, ChurchN(n - 1));
  }
};

/*
 * To verify that combinator expressions produce n applications of f on x,
 * this function is introduced which runs the combinator forward with a lambda
 * that adds one to its argument and returns a number.
 *
 * This is needed because each function has infinitely many representations
 * in the SKI combinators, but we are concerned with whether a given function
 * represents a given Church numeral, regardless of which one it is. This is
 * the notion of extensional equality.
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
  const testExpr = symbolicEvaluator.reduce(apply(expr, ChurchN(1), ChurchN(0)));
  return UnChurchNumber(testExpr) === 1;
};

export const ChurchB = (b: boolean): SKIExpression => b ? True : False;
