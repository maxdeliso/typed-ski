import { Expression, prettyPrint } from './expression'
import { nt } from './nonterminal'
import { TerminalSymbol } from './terminal'

/**
  * the shape of an evaluation result.
  * altered is set if the evaluation step changed the input.
  * expr is the evaluation output.
  */
export interface Result<E> {
  altered: boolean;
  expr: E;
}

/**
 * a computation step; takes an expression and returns a result.
 */
export type Step<E> = (expr: E) => Result<E>

/**
 * the SKI combinator reduction function.
 * @param expr the input expression.
 * @returns the evaluation result after one step.
 *
 * NOTE: this function is not guaranteed to terminate
 */
export const stepMany: Step<Expression> =
  (expr: Expression) => {
    const result = stepOnce(expr)

    if (result.altered) {
      return stepMany(result.expr)
    } else {
      return result
    }
  }

export const loggedStepMany: Step<Expression> =
  (expr: Expression) => {
    console.log(prettyPrint(expr))
    console.log('->')
    const result = stepOnce(expr)

    if (result.altered) {
      return loggedStepMany(result.expr)
    } else {
      return result
    }
  }

/**
 * Run β reduction on a SKI expression until it terminates.
 * @param exp the input expression.
 * @returns the evaluation result.
 */
export const reduce = (exp: Expression): Expression =>
  stepMany(exp).expr

/**
 * Run β reduction on a SKI expression until it terminates.
 * @param exp the input expression.
 * @returns the evaluation result.
 */
export const loggedReduce = (exp: Expression): Expression =>
  loggedStepMany(exp).expr

/**
 * the SKI combinator single step reduction function.
 * @param expr the input expression.
 * @returns the evaluation result after one step.
 */
export const stepOnce: Step<Expression> =
  (expr: Expression) => scanStep(expr, [stepOnceI, stepOnceK, stepOnceS])

const stepOnceI: Step<Expression> =
  (expr: Expression) => treeStep(expr, stepI)

const stepOnceK: Step<Expression> =
  (expr: Expression) => treeStep(expr, stepK)

const stepOnceS: Step<Expression> =
  (expr: Expression) => treeStep(expr, stepS)

/**
 * @param expr the expression to scan with steppers.
 * @param steppers a list of steppers to try on the entire expression.
 * @returns the expression with the first possible step in the list applied.
 *
 * NOTE: this is an eagerly returning fold
 */
const scanStep = (expr: Expression, steppers: Array<Step<Expression>>):
  Result<Expression> => {
  for (const step of steppers) {
    const result = step(expr)

    if (result.altered) {
      return result
    }
  }

  return {
    altered: false,
    expr
  }
}

/**
 * @param expr the input expression
 * @param step a stepper
 * @returns the result of traversing the tree to determine if the step
 * resulted in an altering.
 *
 * NOTE: this is an implementation of DFS where the expression
 * is the input and a singular function that processes an expression
 * and returns either nothing or some result, returning eagerly.
 */
function treeStep (expr: Expression, step: Step<Expression>):
  Result<Expression> {
  switch (expr.kind) {
    case 'terminal':
      return ({
        altered: false,
        expr
      })

    case 'non-terminal': {
      const currentResult = step(expr)

      if (currentResult.altered) {
        return currentResult
      }

      const lftStepResult = treeStep(expr.lft, step)

      if (lftStepResult.altered) {
        return ({
          altered: true,
          expr: nt(lftStepResult.expr, expr.rgt)
        })
      }

      const rgtStepResult = treeStep(expr.rgt, step)

      return {
        altered: rgtStepResult.altered,
        expr: nt(expr.lft, rgtStepResult.expr)
      }
    }
  }
}

type ExtractStep<E> = (expr: E) => E | false

function extractStep (expr: Expression, extractStep: ExtractStep<Expression>):
  Result<Expression> {
  const extractionResult = extractStep(expr)

  if (extractionResult) {
    return ({ altered: true, expr: extractionResult })
  } else {
    return ({ altered: false, expr })
  }
}

/*
 * identity
 * Ix = x
 */
const stepI: Step<Expression> = (expr: Expression) =>
  extractStep(
    expr, (expr: Expression) =>
      expr.kind === 'non-terminal' &&
      expr.lft.kind === 'terminal' &&
      expr.lft.sym === TerminalSymbol.I &&
      expr.rgt
  )

/*
 * constant
 * Kxy = x
 */
const stepK: Step<Expression> = (expr: Expression) =>
  extractStep(
    expr, (expr: Expression) =>
      expr.kind === 'non-terminal' &&
      expr.lft.kind === 'non-terminal' &&
      expr.lft.lft.kind === 'terminal' &&
      expr.lft.lft.sym === TerminalSymbol.K &&
      expr.lft.rgt
  )

/*
 * fusion
 * Sxyz = xz(yz)
 */
const stepS: Step<Expression> = (expr: Expression) =>
  extractStep(
    expr, (expr: Expression) => {
      if (
        expr.kind === 'non-terminal' &&
        expr.lft.kind === 'non-terminal' &&
        expr.lft.lft.kind === 'non-terminal' &&
        expr.lft.lft.lft.kind === 'terminal' &&
        expr.lft.lft.lft.sym === TerminalSymbol.S
      ) {
        const x = expr.lft.lft.rgt
        const y = expr.lft.rgt
        const z = expr.rgt

        return nt(nt(x, z), nt(y, z))
      } else {
        return false
      }
    }
  )
