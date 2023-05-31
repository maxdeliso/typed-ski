import { stepOnce } from './evaluator'
import { NonTerminal, nt } from './nonterminal'
import { generate as generateTerminal, Terminal } from './terminal'
import { RandomSeed } from 'random-seed'

/**
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
export type Expression = Terminal | NonTerminal<Expression>

/**
  * @param expr an expression to pretty print.
  * @returns a pretty printed expression.
  */
export function prettyPrint (expr: Expression): string {
  switch (expr.kind) {
    case 'terminal':
      return expr.sym
    case 'non-terminal': {
      const printed = [
        '(',
        `${prettyPrint(expr.lft)}`,
        `${prettyPrint(expr.rgt)}`,
        ')'
      ]

      return printed.join('')
    }
  }
}

/**
  * @param rs a random seed.
  * @param n the number of symbols to include in the expression.
  * @returns a randomly generated expression.
  */
export function generate (rs: RandomSeed, n: number): Expression {
  if (n <= 0) {
    throw new Error('A valid expression must contain at least one symbol.')
  }

  let result: Expression = generateTerminal(rs)

  for (let i = 0; i < n - 1; i++) {
    result = splat(rs, result, generateTerminal(rs))
  }

  return result
}

/**
  * @param exp an abstract expression.
  * @returns how many terminals are present in the expression.
  */
export function size (exp: Expression): number {
  if (exp.kind === 'terminal') return 1
  else return size(exp.lft) + size(exp.rgt)
}

/**
 * Apply a function to its arguments.
 * @param lft the function.
 * @param rgt the arguments.
 * @returns an unevaluated result.
 */
export const apply = (...exps: Expression[]): Expression => {
  if (exps.length < 0) {
    throw new Error('there must be at least one expression to apply')
  } else {
    return exps.reduce(nt<Expression>)
  }
}

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
export function compute (
  S: number,
  N: number,
  rs: RandomSeed,
  onStep: (_: Expression) => void,
  onRegenerate: (_: Expression) => void): Expression {
  let exp = generate(rs, S)

  for (let i = 0; i < N; i++) {
    const stepResult = stepOnce(exp)

    if (stepResult.altered) {
      exp = stepResult.expr
      onStep(exp)
    } else {
      exp = generate(rs, S)
      onRegenerate(exp)
    }
  }

  return exp
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
const splat = (randomSeed: RandomSeed, expr: Expression, term: Terminal):
  Expression => {
  const direction = randomSeed.intBetween(0, 1) === 1

  if (expr.kind === 'terminal') {
    if (direction) {
      return nt(expr, term)
    } else {
      return nt(term, expr)
    }
  } else if (direction) {
    return nt(splat(randomSeed, expr.lft, term), expr.rgt)
  } else {
    return nt(expr.lft, splat(randomSeed, expr.rgt, term))
  }
}
