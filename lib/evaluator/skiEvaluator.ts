import { cons, ConsCell } from '../cons.ts';
import { prettyPrint, SKIExpression } from '../ski/expression.ts';
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

/**
 * Repeatedly applies SKI reduction steps until no further reductions are possible.
 * WARNING: This function may not terminate if the expression has an infinite reduction sequence.
 * @param expr the input SKI expression
 * @returns the fully reduced expression
 */
const stepMany = (expr: SKIExpression): SKIExpression => {
  let current = expr;
  for (;;) {
    const result = stepOnceSKI(current);
    if (!result.altered) {
      break;
    }
    current = result.expr;
  }
  return current;
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

// Frames only ever hold non-terminals.
interface Frame {
  node: ConsCell<SKIExpression>;
  phase: 'left' | 'right';
  // When phase is 'right', leftResult holds the result for the left subtree.
  leftResult?: SKIResult<SKIExpression>;
}

/**
 * This function iterates through a tree of SKI exprsesions applying a step function
 * to each non-terminal node.
 *
 * It simulates the recursive DFS:
 *
 *    treeStep(expr):
 *      if expr is terminal, return {altered: false, expr}
 *      else try to rewrite at expr with step;
 *           if rewrite succeeds, return the result;
 *           else let L = treeStep(expr.lft);
 *                if L.altered, return {altered: true, expr: cons(L.expr, expr.rgt)}
 *                else let R = treeStep(expr.rgt)
 *                     return {altered: R.altered, expr: cons(expr.lft, R.expr)}
 *
 * Iterative DFS that applies the combinator rewrite function (step)
 * while memoizing evaluated subtrees (using prettyPrint as a canonical key).
 *
 * If a node’s string representation is seen before, its previously computed
 * result is immediately returned, thus preventing cycles or re‑evaluation.
 */
function treeStep(
  expr: SKIExpression,
  step: SKIStep<SKIExpression>
): SKIResult<SKIExpression> {
  const memo = new Map<string, SKIResult<SKIExpression>>();
  const stack: Frame[] = [];
  let current: SKIExpression = expr;
  let result: SKIResult<SKIExpression>;

  for(;;) {
    const key = prettyPrint(current);
    if (memo.has(key)) {
      // If we've already computed the result for this subtree, use it.
      const cached = memo.get(key);
      if (!cached) {
        throw new Error('missing cached result');
      }
      result = cached;
    } else {
      if (current.kind === 'terminal') {
        // Terminal nodes are already in normal form.
        result = { altered: false, expr: current };
      } else {
        // Attempt to rewrite this non-terminal node.
        const stepResult = step(current);
        if (stepResult.altered) {
          result = stepResult;
        } else {
          // No rewrite occurred; we must process the left subtree.
          stack.push({ node: current, phase: 'left' });
          current = current.lft;
          continue; // descend into left child
        }
      }
      // Memoize the result for current's canonical key.
      memo.set(key, result);
    }

    // If there's nothing on the stack, we're done.
    if (stack.length === 0) {
      return result;
    }

    // Otherwise, pop a frame from the stack.
    const frame = stack.pop();
    if (!frame) {
      throw new Error('stack underflow');
    } else if (frame.phase === 'left') {
      // We have just finished processing the left subtree.
      if (result.altered) {
        // According to the rewrite rules, if the left subtree changed,
        // the whole node becomes cons(rewrittenLeft, original right)
        result = { altered: true, expr: cons(result.expr, frame.node.rgt) };
        // Memoize the combined result using the parent's key.
        memo.set(prettyPrint(frame.node), result);
      } else {
        // Left subtree was unchanged.
        // Save the left result in the frame and now descend into the right child.
        stack.push({ node: frame.node, phase: 'right', leftResult: { altered: false, expr: frame.node.lft } });
        current = frame.node.rgt;
        continue; // descend into right child
      }
    } else {
      // frame.phase === 'right'
      // We have finished processing the right subtree. Combine the left and right results.

      if (!frame.leftResult) {
        throw new Error('missing left result');
      }

      result = { altered: result.altered, expr: cons(frame.leftResult.expr, result.expr) };
      // Memoize the result for the parent node.
      memo.set(prettyPrint(frame.node), result);
    }

    // Check if there are any remaining frames; if not, return the result.
    if (stack.length === 0) {
      return result;
    }

    // Otherwise, continue processing: set current to the just-combined expression.
    current = result.expr;
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
