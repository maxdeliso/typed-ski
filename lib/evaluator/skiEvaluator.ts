import { SKIExpression, prettyPrint } from '../ski/expression'
import { nt } from '../nonterminal'
import { SKITerminalSymbol } from '../ski/terminal'

/**
  * the shape of an evaluation result.
  * altered is set if the evaluation step changed the input.
  * expr is the evaluation output.
  */
export interface SKIResult<E> {
  altered: boolean;
  expr: E;
}

/**
 * a computation step; takes an expression and returns a result.
 */
export type SKIStep<E> = (expr: E) => SKIResult<E>

/**
 * the SKI combinator reduction function.
 * @param expr the input expression.
 * @returns the evaluation result after one step.
 *
 * NOTE: this function is not guaranteed to terminate
 */
export const stepMany: SKIStep<SKIExpression> =
  (expr: SKIExpression) => {
    const result = stepOnceSKI(expr)

    if (result.altered) {
      return stepMany(result.expr)
    } else {
      return result
    }
  }

export const loggedStepMany: SKIStep<SKIExpression> =
  (expr: SKIExpression) => {
    console.log(prettyPrint(expr))
    console.log('->')
    const result = stepOnceSKI(expr)

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
export const reduceSKI = (
  exp: SKIExpression
): SKIExpression =>
  stepMany(exp).expr

/**
 * Run β reduction on a SKI expression until it terminates.
 * @param exp the input expression.
 * @returns the evaluation result.
 */
export const loggedReduceSKI = (
  exp: SKIExpression
): SKIExpression =>
  loggedStepMany(exp).expr

/**
 * the SKI combinator single step reduction function.
 * @param expr the input expression.
 * @returns the evaluation result after one step.
 */
export const stepOnceSKI: SKIStep<SKIExpression> =
  (expr: SKIExpression) =>
    scanStep(expr, [stepOnceI, stepOnceK, stepOnceS])

const stepOnceI: SKIStep<SKIExpression> =
  (expr: SKIExpression) => treeStep(expr, stepI)

const stepOnceK: SKIStep<SKIExpression> =
  (expr: SKIExpression) => treeStep(expr, stepK)

const stepOnceS: SKIStep<SKIExpression> =
  (expr: SKIExpression) => treeStep(expr, stepS)

/**
 * @param expr the expression to scan with steppers.
 * @param steppers a list of steppers to try on the entire expression.
 * @returns the expression with the first possible step in the list applied.
 *
 * NOTE: this is an eagerly returning fold
 */
const scanStep = (
  expr: SKIExpression,
  steppers: Array<SKIStep<SKIExpression>>
):
  SKIResult<SKIExpression> => {
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
function treeStep (
  expr: SKIExpression,
  step: SKIStep<SKIExpression>
):
  SKIResult<SKIExpression> {
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

function extractStep (
  expr: SKIExpression,
  extractStep: ExtractStep<SKIExpression>
):
  SKIResult<SKIExpression> {
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
const stepI: SKIStep<SKIExpression> = (expr: SKIExpression) =>
  extractStep(
    expr, (expr: SKIExpression) =>
      expr.kind === 'non-terminal' &&
      expr.lft.kind === 'terminal' &&
      expr.lft.sym === SKITerminalSymbol.I &&
      expr.rgt
  )

/*
 * constant
 * Kxy = x
 */
const stepK: SKIStep<SKIExpression> = (expr: SKIExpression) =>
  extractStep(
    expr, (expr: SKIExpression) =>
      expr.kind === 'non-terminal' &&
      expr.lft.kind === 'non-terminal' &&
      expr.lft.lft.kind === 'terminal' &&
      expr.lft.lft.sym === SKITerminalSymbol.K &&
      expr.lft.rgt
  )

/*
 * fusion
 * Sxyz = xz(yz)
 */
const stepS: SKIStep<SKIExpression> = (expr: SKIExpression) =>
  extractStep(
    expr, (expr: SKIExpression) => {
      if (
        expr.kind === 'non-terminal' &&
        expr.lft.kind === 'non-terminal' &&
        expr.lft.lft.kind === 'non-terminal' &&
        expr.lft.lft.lft.kind === 'terminal' &&
        expr.lft.lft.lft.sym === SKITerminalSymbol.S
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
