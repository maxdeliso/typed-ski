import { cons } from '../cons.ts';
import { SKIExpression } from '../ski/expression.ts';
import { SKITerminalSymbol } from '../ski/terminal.ts';

/**
  * the shape of an evaluation result.
  * altered is set if the evaluation step changed the input.
  * expr is the evaluation output.
  */
export interface SKIResult<E> {
  altered: boolean;
  expr: E;
}

type ExtractStep<E> = (expr: E) => E | false;

const stepMany = (expr: SKIExpression): SKIExpression => {
  const result = stepOnceSKI(expr);

  if (result.altered) {
    return stepMany(result.expr);
  } else {
    return result.expr;
  }
};

/**
 * Run β reduction on a SKI expression until it terminates.
 * @param exp the input expression.
 * @returns the evaluation result.
 */
export const reduceSKI = (
  exp: SKIExpression
): SKIExpression => stepMany(exp);

/**
 * the SKI combinator single step reduction function.
 * @param expr the input expression.
 * @returns the evaluation result after one step.
 */
export const stepOnceSKI =
  (expr: SKIExpression) =>
    scanStep(expr, [stepOnceI, stepOnceK, stepOnceS]);

const stepOnceI =
  (expr: SKIExpression) => treeStep(expr, stepI);

const stepOnceK =
  (expr: SKIExpression) => treeStep(expr, stepK);

const stepOnceS =
  (expr: SKIExpression) => treeStep(expr, stepS);

/**
 * @param expr the expression to scan with steppers.
 * @param steppers a list of steppers to try on the entire expression.
 * @returns the expression with the first possible step in the list applied.
 *
 * NOTE: this is an eagerly returning fold
 */
const scanStep = (
  expr: SKIExpression,
  steppers: SKIStep<SKIExpression>[]
): SKIResult<SKIExpression> => {
  for (const step of steppers) {
    const result = step(expr);

    if (result.altered) {
      return result;
    }
  }

  return {
    altered: false,
    expr
  };
};

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
function treeStep(
  expr: SKIExpression,
  step: SKIStep<SKIExpression>
):
  SKIResult<SKIExpression> {
  switch (expr.kind) {
    case 'terminal':
      return ({
        altered: false,
        expr
      });

    case 'non-terminal': {
      const currentResult = step(expr);

      if (currentResult.altered) {
        return currentResult;
      }

      const lftStepResult = treeStep(expr.lft, step);

      if (lftStepResult.altered) {
        return ({
          altered: true,
          expr: cons(lftStepResult.expr, expr.rgt)
        });
      }

      const rgtStepResult = treeStep(expr.rgt, step);

      return {
        altered: rgtStepResult.altered,
        expr: cons(expr.lft, rgtStepResult.expr)
      };
    }
  }
}

function extractStep(
  expr: SKIExpression,
  extractStep: ExtractStep<SKIExpression>
):
  SKIResult<SKIExpression> {
  const extractionResult = extractStep(expr);

  if (extractionResult) {
    return ({ altered: true, expr: extractionResult });
  } else {
    return ({ altered: false, expr });
  }
}


type SKIStep<E> = (input: E) => SKIResult<E>;

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
  );

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
  );

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
        const x = expr.lft.lft.rgt;
        const y = expr.lft.rgt;
        const z = expr.rgt;

        return cons(cons(x, z), cons(y, z));
      } else {
        return false;
      }
    }
  );
