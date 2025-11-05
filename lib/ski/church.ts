/**
 * Church encoding utilities for SKI expressions.
 *
 * This module provides functionality for working with Church encodings of
 * numbers and booleans in SKI combinator expressions, including conversion
 * to and from JavaScript values.
 *
 * @module
 */
import { B, False, One, Succ, True, Zero } from "../consts/combinators.ts";
import { apply, applyMany, type SKIExpression } from "./expression.ts";
import { symbolicEvaluator } from "../evaluator/skiEvaluator.ts";
import { unChurchNumber as unChurchNumberNative } from "./native.ts";

// Memoization cache for optimized Church numerals
const churchCache = new Map<number, SKIExpression>();

// Pre-compute Church numeral 2 for efficiency
let ChurchTwo: SKIExpression | null = null;

/**
 * Checks if n is a perfect power: n = a^b for integers a, b > 1
 * Returns [a, b] if found, null otherwise.
 * Prefers smallest exponent b to minimize application depth.
 *
 * @internal Exported for testing purposes
 */
export function findPerfectPower(n: number): [number, number] | null {
  if (n < 4) return null; // 0, 1, 2, 3 are not perfect powers (with b > 1)

  // Try exponents from 2 up to log2(n)
  const maxExponent = Math.floor(Math.log2(n));
  for (let b = 2; b <= maxExponent; b++) {
    // Try bases from 2 up to n^(1/b)
    // Use ceil to account for floating point precision issues
    const maxBase = Math.ceil(Math.pow(n, 1 / b));
    for (let a = 2; a <= maxBase; a++) {
      const power = Math.pow(a, b);
      if (power === n) {
        return [a, b];
      }
      if (power > n) break;
    }
  }
  return null;
}

/**
 * Finds factors of a composite number.
 * Returns [a, b] where a * b = n, preferring balanced factors.
 * Returns null if n is prime.
 *
 * @internal Exported for testing purposes
 */
export function findFactors(n: number): [number, number] | null {
  if (n < 4) return null; // 0, 1, 2, 3 are not composite (or trivial)

  // Try to find the smallest factor (peel off smallest prime)
  const sqrtN = Math.sqrt(n);
  for (let a = 2; a <= sqrtN; a++) {
    if (n % a === 0) {
      return [a, n / a];
    }
  }
  return null;
}

/**
 * Represents a deferred computation for building a Church numeral.
 * Once all dependencies are resolved, we can build the final expression.
 */
type DeferredComputation =
  | { type: "perfectPower"; base: number; exponent: number }
  | { type: "composite"; factor1: number; factor2: number }
  | { type: "prime"; predecessor: number };

/**
 * Optimized Church numeral generation using factorization hierarchy:
 * 1. Memoization & Base Cases (0, 1, 2)
 * 2. Perfect Power Check (highest priority - exponentiation)
 * 3. Composite Check (medium priority - multiplication/composition)
 * 4. Prime Fallback (lowest priority - successor)
 *
 * This implementation is iterative and stack-safe, using a work queue
 * to process dependencies without recursion.
 */
function optimizeChurchN(n: number): SKIExpression {
  // Check cache
  const cached = churchCache.get(n);
  if (cached !== undefined) {
    return cached;
  }

  // Work queue: numbers that need to be optimized
  const workQueue: number[] = [n];
  // Maps numbers to their deferred computations
  const deferred: Map<number, DeferredComputation> = new Map();
  // Set of numbers we've already analyzed (to avoid reprocessing)
  const analyzed = new Set<number>();

  // Process work queue iteratively to collect all dependencies
  while (workQueue.length > 0) {
    const current = workQueue.pop()!;

    // Skip if already cached or already analyzed
    if (churchCache.has(current) || analyzed.has(current)) {
      continue;
    }

    analyzed.add(current);

    // Base cases - resolve immediately
    if (current === 0) {
      churchCache.set(current, Zero);
      continue;
    } else if (current === 1) {
      churchCache.set(current, One);
      continue;
    } else if (current === 2) {
      if (ChurchTwo === null) {
        ChurchTwo = apply(Succ, One);
      }
      churchCache.set(current, ChurchTwo);
      continue;
    }

    // Determine the computation strategy and record dependencies
    const perfectPower = findPerfectPower(current);
    if (perfectPower !== null) {
      const [a, b] = perfectPower;
      // Need to compute both a and b first
      deferred.set(current, { type: "perfectPower", base: a, exponent: b });
      if (!churchCache.has(a) && !analyzed.has(a)) workQueue.push(a);
      if (!churchCache.has(b) && !analyzed.has(b)) workQueue.push(b);
    } else {
      const factors = findFactors(current);
      if (factors !== null) {
        const [a, b] = factors;
        // Need to compute both factors first
        deferred.set(current, { type: "composite", factor1: a, factor2: b });
        if (!churchCache.has(a) && !analyzed.has(a)) workQueue.push(a);
        if (!churchCache.has(b) && !analyzed.has(b)) workQueue.push(b);
      } else {
        // Prime - need predecessor
        deferred.set(current, { type: "prime", predecessor: current - 1 });
        if (!churchCache.has(current - 1) && !analyzed.has(current - 1)) {
          workQueue.push(current - 1);
        }
      }
    }
  }

  // Now resolve all deferred computations
  // Process dependencies in topological order (smallest to largest)
  // to ensure dependencies are resolved before they're used
  const sortedNumbers = Array.from(deferred.keys()).sort((a, b) => a - b);

  for (const num of sortedNumbers) {
    if (churchCache.has(num)) continue; // Already resolved

    const comp = deferred.get(num);
    if (!comp) {
      throw new Error(`Missing deferred computation for ${num}`);
    }

    // Get dependencies, recursively computing if needed
    let result: SKIExpression;

    switch (comp.type) {
      case "perfectPower": {
        // Recursively ensure dependencies are computed
        const baseExpr = optimizeChurchN(comp.base);
        const expExpr = optimizeChurchN(comp.exponent);
        // n = a^b: Church encoding is b applied to a
        result = apply(expExpr, baseExpr);
        break;
      }
      case "composite": {
        // Recursively ensure dependencies are computed
        const factor1Expr = optimizeChurchN(comp.factor1);
        const factor2Expr = optimizeChurchN(comp.factor2);
        // n = a * b: Church encoding uses composition B
        result = applyMany(B, factor1Expr, factor2Expr);
        break;
      }
      case "prime": {
        // Recursively ensure predecessor is computed
        const predExpr = optimizeChurchN(comp.predecessor);
        // Prime - use successor
        result = apply(Succ, predExpr);
        break;
      }
    }

    churchCache.set(num, result);
  }

  // Return the result for n
  const finalResult = churchCache.get(n);
  if (!finalResult) {
    throw new Error(`Failed to compute Church numeral for ${n}`);
  }
  return finalResult;
}

/**
 * Creates a Church-encoded numeral from a JavaScript number.
 *
 * Church numerals represent natural numbers as functions that apply another function
 * a specified number of times. For example, Church numeral 2 applies a function f
 * twice: f(f(x)).
 *
 * This implementation uses an optimized factorization hierarchy algorithm that
 * prioritizes operations by efficiency:
 * - Exponentiation (application) - highest priority
 * - Multiplication (composition) - medium priority
 * - Successor (addition) - lowest priority
 *
 * @see https://en.wikipedia.org/wiki/Church_encoding
 * @param n a non-negative integer
 * @returns an extensionally equivalent Church numeral as an SKI expression
 * @throws Error if n is not an integer or is negative
 */
export const ChurchN = (n: number): SKIExpression => {
  if (!Number.isInteger(n)) {
    throw new Error("ChurchN only accepts integers");
  }
  if (n < 0) {
    throw new Error("only non-negative integers are supported");
  }
  return optimizeChurchN(n);
};

/**
 * Evaluates a Church numeral SKI expression to a JavaScript number using the optimized native path.
 *
 * Useful for testing numeric results of SKI computations via Church encoding.
 */
export const UnChurchNumber = (exp: SKIExpression): number => {
  return unChurchNumberNative(exp);
};

/**
 * UnChurchBoolean applies the Church boolean expression (which is expected to be in normal form)
 * to two Church numerals (here ChurchN(1) and ChurchN(0)) and then uses UnChurch to obtain a number.
 * If the result is 1, then the Church boolean was true; if 0, then it was false.
 */
export const UnChurchBoolean = (expr: SKIExpression): boolean => {
  // Apply the Church boolean to ChurchN(1) (for true) and ChurchN(0) (for false)
  const testExpr = symbolicEvaluator.reduce(
    applyMany(expr, ChurchN(1), ChurchN(0)),
  );
  return UnChurchNumber(testExpr) === 1;
};

export const ChurchB = (b: boolean): SKIExpression => b ? True : False;
