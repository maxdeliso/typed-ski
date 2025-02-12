import { cons, ConsCell } from '../cons.js';
import { expressionEquivalent, SKIExpression, toSKIKey } from '../ski/expression.js';
import { SKITerminalSymbol } from '../ski/terminal.js';
import { createMap, searchMap, insertMap, SKIMap } from '../data/map/skiMap.js';

/**
 * The internal shape of an evaluation result.
 * - `altered` is true if the reduction changed the input.
 * - `expr` is the (possibly reduced) output.
 */
interface SKIResult<E> {
  altered: boolean;
  expr: E;
}

type ExtractStep<E> = (expr: E) => E | false;
type SKIStep<E> = (input: E) => SKIResult<E>;

/**
 * Helper that applies a step function; if the extraction function returns a new expression,
 * we mark the step as having altered the expression.
 */
function extractStep(
  expr: SKIExpression,
  extractFn: ExtractStep<SKIExpression>
): SKIResult<SKIExpression> {
  const extractionResult = extractFn(expr);
  return extractionResult
    ? { altered: true, expr: extractionResult }
    : { altered: false, expr };
}

const stepI: SKIStep<SKIExpression> = (expr: SKIExpression) =>
  extractStep(expr, (e: SKIExpression) =>
    e.kind === 'non-terminal' &&
    e.lft.kind === 'terminal' &&
    e.lft.sym === SKITerminalSymbol.I &&
    e.rgt
  );

const stepK: SKIStep<SKIExpression> = (expr: SKIExpression) =>
  extractStep(expr, (e: SKIExpression) =>
    e.kind === 'non-terminal' &&
    e.lft.kind === 'non-terminal' &&
    e.lft.lft.kind === 'terminal' &&
    e.lft.lft.sym === SKITerminalSymbol.K &&
    e.lft.rgt
  );

const stepS: SKIStep<SKIExpression> = (expr: SKIExpression) =>
  extractStep(expr, (e: SKIExpression) => {
    if (
      e.kind === 'non-terminal' &&
      e.lft.kind === 'non-terminal' &&
      e.lft.lft.kind === 'non-terminal' &&
      e.lft.lft.lft.kind === 'terminal' &&
      e.lft.lft.lft.sym === SKITerminalSymbol.S
    ) {
      const x = e.lft.lft.rgt;
      const y = e.lft.rgt;
      const z = e.rgt;
      return cons(cons(x, z), cons(y, z));
    } else {
      return false;
    }
  });

/**
 * A frame used for DFS during the memoized (cached) tree‐step.
 */
interface Frame {
  node: ConsCell<SKIExpression>;
  phase: 'left' | 'right';
  // When phase is 'right', `leftResult` holds the reduced left subtree.
  leftResult?: SKIResult<SKIExpression>;
}

/**
 * Global memoization cache.
 */
let globalMemo: SKIMap = createMap();

/**
 * DFS‑based tree-step that uses the global memoization cache.
 * If a node's canonical key is already cached, its result is reused.
 */
function treeStep(
  expr: SKIExpression,
  step: SKIStep<SKIExpression>
): SKIResult<SKIExpression> {
  const stack: Frame[] = [];
  let current: SKIExpression = expr;
  let result: SKIResult<SKIExpression>;

  for (;;) {
    const key = toSKIKey(current);
    const memoized = searchMap(globalMemo, key);
    if (memoized !== undefined) {
      const memoDiff = !expressionEquivalent(current, memoized);
      result = { altered: memoDiff, expr: memoized };
    } else {
      if (current.kind === 'terminal') {
        result = { altered: false, expr: current };
      } else {
        const stepResult = step(current);
        if (stepResult.altered) {
          result = stepResult;
        } else {
          // No reduction at this node; descend into the left subtree.
          stack.push({ node: current, phase: 'left' });
          current = current.lft;
          continue;
        }
      }
      // Cache the result.
      globalMemo = insertMap(globalMemo, key, result.expr);
    }

    if (stack.length === 0) {
      return result;
    }

    // Pop a frame and combine results.
    const frame = stack.pop();
    if (!frame) {
      throw new Error('Expected stack frame but got undefined');
    }
    if (frame.phase === 'left') {
      if (result.altered) {
        result = { altered: true, expr: cons(result.expr, frame.node.rgt) };
        globalMemo = insertMap(globalMemo, toSKIKey(frame.node), result.expr);
      } else {
        stack.push({
          node: frame.node,
          phase: 'right',
          leftResult: { altered: false, expr: frame.node.lft }
        });
        current = frame.node.rgt;
        continue;
      }
    } else { // frame.phase === 'right'
      if (!frame.leftResult) throw new Error('missing left result');
      result = { altered: result.altered, expr: cons(frame.leftResult.expr, result.expr) };
      globalMemo = insertMap(globalMemo, toSKIKey(frame.node), result.expr);
    }
    if (stack.length === 0) return result;
    current = result.expr;
  }
}

/**
 * Helper that tries a list of step functions (in order) on the given expression.
 */
function scanStep(
  expr: SKIExpression,
  steppers: SKIStep<SKIExpression>[]
): SKIResult<SKIExpression> {
  for (const step of steppers) {
    const result = step(expr);
    if (result.altered) {
      return result;
    }
  }
  return { altered: false, expr };
}

/**
 * Step‑once (cached version) using the DFS tree step and global memoization.
 */
const stepOnceMemoized = (expr: SKIExpression): SKIResult<SKIExpression> =>
  scanStep(expr, [e => treeStep(e, stepS), e => treeStep(e, stepK), e => treeStep(e, stepI)]);

/**
 * Step‑once (immediate version) that does not use caching.
 */
export const stepOnceImmediate = (expr: SKIExpression): SKIResult<SKIExpression> => {
  if (expr.kind === 'terminal') return { altered: false, expr };
  const iStep = stepI(expr);
  if (iStep.altered) return iStep;
  const kStep = stepK(expr);
  if (kStep.altered) return kStep;
  const sStep = stepS(expr);
  if (sStep.altered) return sStep;
  const leftResult = stepOnceImmediate(expr.lft);
  if (leftResult.altered) return { altered: true, expr: cons(leftResult.expr, expr.rgt) };
  const rightResult = stepOnceImmediate(expr.rgt);
  if (rightResult.altered) return { altered: true, expr: cons(expr.lft, rightResult.expr) };
  return { altered: false, expr };
};

/**
 * Repeatedly applies cached reduction steps until no more changes occur
 * or until the maximum number of iterations is reached.
 *
 * @param exp the initial SKI expression.
 * @param maxIterations (optional) the maximum number of reduction iterations.
 *                      If omitted, the reduction will continue until a fixed point is reached.
 * @returns the reduced SKI expression.
 */
export const reduce = (exp: SKIExpression, maxIterations?: number): SKIExpression => {
  let current = exp;
  let result = stepOnceMemoized(current);
  let iterations = 0;
  const maxIter = maxIterations ?? Infinity;

  while (result.altered && iterations < maxIter) {
    current = result.expr;
    result = stepOnceMemoized(current);
    iterations++;
  }

  return current;
};
