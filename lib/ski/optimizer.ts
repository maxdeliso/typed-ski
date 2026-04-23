import { apply, applyMany, type SKIExpression } from "./expression.ts";
import {
  B,
  BPrime,
  C,
  CPrime,
  K,
  S,
  SPrime,
  type SKITerminalSymbol,
} from "./terminal.ts";

function isTerminal(
  expr: SKIExpression,
  sym: SKITerminalSymbol,
): boolean {
  return expr.kind === "terminal" && expr.sym === sym;
}

function makeApp(left: SKIExpression, right: SKIExpression): SKIExpression {
  return apply(left, right);
}

function appParts(
  expr: SKIExpression,
): [left: SKIExpression, right: SKIExpression] | null {
  if (expr.kind !== "non-terminal") {
    return null;
  }
  return [expr.lft, expr.rgt];
}

function matchBinaryHead(
  expr: SKIExpression,
  head: SKITerminalSymbol,
): [first: SKIExpression, second: SKIExpression] | null {
  const outer = appParts(expr);
  if (outer === null) {
    return null;
  }

  const inner = appParts(outer[0]);
  if (inner === null || !isTerminal(inner[0], head)) {
    return null;
  }

  return [inner[1], outer[1]];
}

function matchBK(
  expr: SKIExpression,
): [first: SKIExpression, second: SKIExpression] | null {
  const pair = matchBinaryHead(expr, B.sym);
  if (pair === null) {
    return null;
  }
  return pair;
}

function matchK(
  expr: SKIExpression,
): SKIExpression | null {
  const parts = appParts(expr);
  if (parts === null || !isTerminal(parts[0], K.sym)) {
    return null;
  }
  return parts[1];
}

function optimizeOnce(expr: SKIExpression): SKIExpression {
  const outer = appParts(expr);
  if (outer === null) {
    return expr;
  }

  const binaryB = matchBinaryHead(expr, B.sym);
  if (binaryB !== null) {
    const [first, second] = binaryB;
    const inner = appParts(first);
    if (inner !== null) {
      return applyMany(BPrime, inner[0], inner[1], second);
    }
  }

  const binaryS = matchBinaryHead(expr, S.sym);
  if (binaryS !== null) {
    const [first, second] = binaryS;

    const firstAsBK = matchBK(first);
    if (firstAsBK !== null) {
      return applyMany(SPrime, firstAsBK[0], firstAsBK[1], second);
    }

    const firstAsK = matchK(first);
    if (firstAsK !== null) {
      return applyMany(B, firstAsK, second);
    }

    const secondAsK = matchK(second);
    if (secondAsK !== null) {
      return applyMany(C, first, secondAsK);
    }
  }

  const binaryC = matchBinaryHead(expr, C.sym);
  if (binaryC !== null) {
    const [first, second] = binaryC;
    const firstAsBK = matchBK(first);
    if (firstAsBK !== null) {
      return applyMany(CPrime, firstAsBK[0], firstAsBK[1], second);
    }
  }

  return expr;
}

function optimizeNode(expr: SKIExpression): SKIExpression {
  if (expr.kind !== "non-terminal") {
    return expr;
  }

  let current: SKIExpression = makeApp(
    optimizeNode(expr.lft),
    optimizeNode(expr.rgt),
  );

  while (true) {
    const next = optimizeOnce(current);
    if (next === current) {
      return current;
    }
    current = optimizeNode(next);
  }
}

/**
 * Rewrites common compiler-emitted SKI spines into fused runtime combinators.
 *
 * The rules here are deliberately conservative: they only introduce fused
 * primitives via direct combinator identities that preserve the original
 * application structure, avoiding eta-like shrinking rewrites.
 */
export function optimizeSKI(expr: SKIExpression): SKIExpression {
  return optimizeNode(expr);
}
