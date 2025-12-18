/**
 * Random SKI expression generation.
 *
 * This module provides functionality for generating random SKI expressions
 * of specified sizes using a random seed for reproducible results.
 *
 * @module
 */
import type { SKIExpression } from "./expression.ts";
import { apply } from "./expression.ts";
import { I, K, S, type SKITerminal } from "./terminal.ts";

/**
 * Simple interface for random number generation.
 * This allows the generator to work with any random number source
 * without bundling specific dependencies.
 */
export interface RandomSource {
  /** Returns a random integer between min (inclusive) and max (inclusive) */
  intBetween(min: number, max: number): number;
}

export const randExpression = (rs: RandomSource, n: number): SKIExpression => {
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
  randomSeed: RandomSource,
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
 * @param rs the random source to use.
 * @returns a randomly selected terminal symbol.
 */
export function randTerminal(rs: RandomSource): SKITerminal {
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
