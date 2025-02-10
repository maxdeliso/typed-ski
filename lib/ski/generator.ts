import { RandomSeed } from 'random-seed';
import { cons } from '../cons.js';
import { SKIExpression } from './expression.js';
import { S, K, I, SKITerminal } from './terminal.js';

export const randExpression = (rs: RandomSeed, n: number): SKIExpression => {
  if (n <= 0) {
    throw new Error('A valid expression must contain at least one symbol.');
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
  term: SKITerminal): SKIExpression => {
  const direction = randomSeed.intBetween(0, 1) === 1;

  if (expr.kind === 'terminal') {
    if (direction) {
      return cons(expr, term);
    } else {
      return cons(term, expr);
    }
  } else if (direction) {
    return cons(randomInsert(randomSeed, expr.lft, term), expr.rgt);
  } else {
    return cons(expr.lft, randomInsert(randomSeed, expr.rgt, term));
  }
};

/**
 * @param rs the random seed to use.
 * @returns a randomly selected terminal symbol.
 */
export function randTerminal (rs: RandomSeed): SKITerminal {
  const die = rs.intBetween(1, 3);

  if (die === 1) {
    return S;
  } else if (die === 2) {
    return K;
  } else if (die === 3) {
    return I;
  } else {
    throw new Error('integer die roll out of range');
  }
}
