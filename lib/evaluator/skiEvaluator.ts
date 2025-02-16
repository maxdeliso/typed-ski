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

/**
 * A step function type.
 */
type SKIStep<E> = (input: E) => SKIResult<E>;

const stepI: SKIStep<SKIExpression> = (expr: SKIExpression) => {
  if (
    expr.kind === 'non-terminal' &&
    expr.lft.kind === 'terminal' &&
    expr.lft.sym === SKITerminalSymbol.I
  ) {
    return { altered: true, expr: expr.rgt };
  }
  return { altered: false, expr };
};

const stepK: SKIStep<SKIExpression> = (expr: SKIExpression) => {
  if (
    expr.kind === 'non-terminal' &&
    expr.lft.kind === 'non-terminal' &&
    expr.lft.lft.kind === 'terminal' &&
    expr.lft.lft.sym === SKITerminalSymbol.K
  ) {
    return { altered: true, expr: expr.lft.rgt };
  }
  return { altered: false, expr };
};

const stepS: SKIStep<SKIExpression> = (expr: SKIExpression) => {
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
    return { altered: true, expr: cons(cons(x, z), cons(y, z)) };
  }
  return { altered: false, expr };
};

/**
 * A frame for the iterative DFS.
 *
 * - phase "left" means we are about to reduce the left child.
 * - phase "right" means the left child is done (its result is in `leftResult`)
 *   and we now need to reduce the right child.
 */
interface Frame {
  node: ConsCell<SKIExpression>;
  phase: 'left' | 'right';
  leftResult?: SKIExpression;
}

/**
 * expressionCache stores associations between an expression's canonical key and its
 * intermediate reduction.
 */
let expressionCache: SKIMap = createMap();

/**
 * evaluationCache stores associations between an expression's canonical key and its
 * fully reduced (normalized) form.
 */
let evaluationCache: SKIMap = createMap();

/**
 * Iteratively performs one DFS-based tree step (one “step‐once”),
 * trying the S, K, and I rules at each node.
 *
 * Uses the evaluation cache only at the very beginning (to avoid work on a fully
 * normalized input) and at the very end (to cache a fully normalized result),
 * while using only the intermediate expressionCache during the DFS.
 */
const stepOnceMemoized = (expr: SKIExpression): SKIResult<SKIExpression> => {
  const orig = expr;
  const origKey = toSKIKey(orig);
  const evalCached = searchMap(evaluationCache, origKey);

  if (evalCached !== undefined) {
    return { altered: !expressionEquivalent(orig, evalCached), expr: evalCached };
  }

  let current: SKIExpression = expr;
  let next: SKIExpression;
  const stack: Frame[] = [];

  for(;;) {
    const key = toSKIKey(current);
    const cached = searchMap(expressionCache, key);
    if (cached !== undefined) {
      next = cached;
    } else {
      if (current.kind === 'terminal') {
        next = current;
      } else {
        let stepResult = stepI(current);
        if (!stepResult.altered) {
          stepResult = stepK(current);
        }
        if (!stepResult.altered) {
          stepResult = stepS(current);
        }
        if (stepResult.altered) {
          next = stepResult.expr;
          expressionCache = insertMap(expressionCache, key, next);
        } else {
          // No rule applied here; continue DFS by descending into the left child.
          stack.push({ node: current, phase: 'left' });
          current = current.lft;
          continue;
        }
      }
    }

    // If there are no frames left, we are at the top level.
    if (stack.length === 0) {
      // Determine if the top-level expression changed.
      const changed = !expressionEquivalent(orig, next);
      // If no change occurred, then newExpr is fully normalized; cache it.
      if (!changed) {
        evaluationCache = insertMap(evaluationCache, origKey, next);
      }
      return { altered: changed, expr: next };
    }

    // Pop a frame and combine the result with its parent.
    const frame = stack.pop()!;
    if (frame.phase === 'left') {
      if (!expressionEquivalent(frame.node.lft, next)) {
        // The left subtree was reduced. Rebuild the parent's node.
        next = cons(next, frame.node.rgt);
        expressionCache = insertMap(expressionCache, toSKIKey(frame.node), next);
      } else {
        // The left branch is fully normalized.
        // Now prepare to reduce the right branch by pushing a frame with phase 'right'
        frame.phase = 'right';
        frame.leftResult = next;
        stack.push(frame);
        current = frame.node.rgt;
        continue;
      }
    } else { // frame.phase === 'right'
      // Now combine the left result (already normalized) with the just-reduced right branch.
      next = cons(frame.leftResult!, next);
      expressionCache = insertMap(expressionCache, toSKIKey(frame.node), next);
    }
    // Propagate the new (combined) expression upward.
    current = next;
  }
};

/**
 * Repeatedly applies reduction steps until no further reduction is possible
 * (or until the maximum number of iterations is reached), then returns the result.
 *
 * @param exp the initial SKI expression.
 * @param maxIterations (optional) the maximum number of reduction iterations.
 * @returns the reduced SKI expression.
 */
export const reduce = (exp: SKIExpression, maxIterations?: number): SKIExpression => {
  let current = exp;
  const maxIter = maxIterations ?? Infinity;
  for (let i = 0; i < maxIter; i++) {
    const result = stepOnceMemoized(current);
    if (!result.altered) {
      return result.expr;
    }
    current = result.expr;
  }
  return current;
};

export const stepOnce = (expr: SKIExpression): SKIResult<SKIExpression> => {
  if (expr.kind === 'terminal') return { altered: false, expr };
  let result = stepI(expr);
  if (result.altered) return result;
  result = stepK(expr);
  if (result.altered) return result;
  result = stepS(expr);
  if (result.altered) return result;
  result = stepOnce(expr.lft);
  if (result.altered) return { altered: true, expr: cons(result.expr, expr.rgt) };
  result = stepOnce(expr.rgt);
  if (result.altered) return { altered: true, expr: cons(expr.lft, result.expr) };
  return { altered: false, expr };
};
