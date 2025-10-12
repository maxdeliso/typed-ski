/**
 * Random SKI expression generation.
 *
 * This module provides functionality for generating random SKI expressions
 * of specified sizes using a random seed for reproducible results.
 *
 * @module
 */
import type { RandomSeed } from "random-seed";
import type { SKIExpression } from "./expression.ts";
import { apply } from "./expression.ts";
import { I, K, S, type SKITerminal } from "./terminal.ts";

export const randExpression = (rs: RandomSeed, n: number): SKIExpression => {
  if (n <= 0) {
    throw new Error("A valid expression must contain at least one symbol.");
  }

  let result: SKIExpression = randTerminal(rs);

  for (let i = 0; i < n - 1; i++) {
    result = randomInsert(rs, result, randTerminal(rs));
  }

  return result;
};

const randomInsert = (
  randomSeed: RandomSeed,
  expr: SKIExpression,
  term: SKITerminal,
): SKIExpression => {
  const direction = randomSeed.intBetween(0, 1) === 1;

  if (expr.kind === "terminal") {
    if (direction) {
      return apply(expr, term);
    } else {
      return apply(term, expr);
    }
  } else if (direction) {
    return apply(randomInsert(randomSeed, expr.lft, term), expr.rgt);
  } else {
    return apply(expr.lft, randomInsert(randomSeed, expr.rgt, term));
  }
};

/**
 * @param rs the random seed to use.
 * @returns a randomly selected terminal symbol.
 */
export function randTerminal(rs: RandomSeed): SKITerminal {
  const die = rs.intBetween(1, 3);

  if (die === 1) {
    return S;
  } else if (die === 2) {
    return K;
  } else if (die === 3) {
    return I;
  } else {
    throw new Error("integer die roll out of range");
  }
}
