import { RandomSeed } from 'random-seed';
import { ConsCell, cons } from '../cons.ts';
import { stepOnceSKI } from '../evaluator/skiEvaluator.ts';
import { SKITerminal, generate } from './terminal.ts';

/*
 * EBNF grammar:
 *
 * terminal = "S" | "K" | "I"
 * non-terminal = "(", expression, expression, ")"
 * expression = terminal | non-terminal
 *
 * alphabet:
 *
 * "S" | "K" | "I" | "(" | ")"
 *
 * non-terminals:
 *
 * terminal | non-terminal | expression
 */
export type SKIExpression = SKITerminal | ConsCell<SKIExpression>;

/**
  * @param expr an expression to pretty print.
  * @returns a pretty printed expression.
  */
export function prettyPrint(expr: SKIExpression): string {
  switch (expr.kind) {
    case 'terminal':
      return expr.sym;
    case 'non-terminal': {
      const printed = [
        '(',
        prettyPrint(expr.lft),
        prettyPrint(expr.rgt),
        ')'
      ];

      return printed.join('');
    }
  }
}

export const generateExpr = (rs: RandomSeed, n: number): SKIExpression => {
  if (n <= 0) {
    throw new Error('A valid expression must contain at least one symbol.');
  }

  let result: SKIExpression = generate(rs);

  for (let i = 0; i < n - 1; i++) {
    result = splat(rs, result, generate(rs));
  }

  return result;
};

/**
  * @param exp an abstract expression.
  * @returns how many terminals are present in the expression.
  */
export function size(exp: SKIExpression): number {
  if (exp.kind === 'terminal') return 1;
  else return size(exp.lft) + size(exp.rgt);
}

/**
 * Apply a function to its arguments.
 * @param exps an array of expressions.
 * @returns an unevaluated result.
 */
export const apply = (...exps: SKIExpression[]): SKIExpression => {
  if (exps.length <= 0) {
    throw new Error('there must be at least one expression to apply');
  } else {
    return exps.reduce(cons<SKIExpression>);
  }
};

/**
 * Run reductions continuously, with the supplied parameters.
 * Note: when an expression can no longer be reduced, a new
 * expression is generated.
 *
 * @param S the number of symbols in each generated expression.
 * @param N the number of reduction steps to take.
 * @param rs the random seed to use to regenerate the expr.
 * @param onStep a callback function for when a step occurs.
 * @param onRegenerate a callback function for when a regeneration occurs.
 */
export function compute(
  S: number,
  N: number,
  rs: RandomSeed,
  onStep: (_: SKIExpression) => void,
  onRegenerate: (_: SKIExpression) => void): SKIExpression {
  let exp = generateExpr(rs, S);

  for (let i = 0; i < N; i++) {
    const stepResult = stepOnceSKI(exp);

    if (stepResult.altered) {
      exp = stepResult.expr;
      onStep(exp);
    } else {
      exp = generateExpr(rs, S);
      onRegenerate(exp);
    }
  }

  return exp;
}

/**
 * Splat a combinator in there randomly.
 *
 * @param randomSeed entropy source
 * @param expr expression
 * @param term the combinator to insert.
 * @returns an expression with the symbol t added in a "random" but deserving
 * location.
 */
const splat = (randomSeed: RandomSeed, expr: SKIExpression, term: SKITerminal):
SKIExpression => {
  const direction = randomSeed.intBetween(0, 1) === 1;

  if (expr.kind === 'terminal') {
    if (direction) {
      return cons(expr, term);
    } else {
      return cons(term, expr);
    }
  } else if (direction) {
    return cons(splat(randomSeed, expr.lft, term), expr.rgt);
  } else {
    return cons(expr.lft, splat(randomSeed, expr.rgt, term));
  }
};

export { reduceSKI } from '../evaluator/skiEvaluator.ts';
