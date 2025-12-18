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
import { arenaEvaluator } from "../evaluator/skiEvaluator.ts";
import { unChurchNumber as unChurchNumberNative } from "./native.ts";

// Memoization cache for optimized Church numerals
const churchCache = new Map<bigint, SKIExpression>();

// Pre-compute Church numeral 2 for efficiency
let ChurchTwo: SKIExpression | null = null;

const toBigInt = (value: number | bigint): bigint => {
  if (typeof value === "bigint") return value;
  if (!Number.isInteger(value)) {
    throw new Error("Only integer values can be converted to Church numerals");
  }
  return BigInt(value);
};

const powBigInt = (base: bigint, exponent: bigint): bigint => {
  let result = 1n;
  let b = base;
  let e = exponent;
  while (e > 0n) {
    if ((e & 1n) === 1n) {
      result *= b;
    }
    if (e === 1n) break;
    b *= b;
    e >>= 1n;
  }
  return result;
};

const sqrtBigInt = (n: bigint): bigint => {
  if (n < 0n) {
    throw new Error("Cannot compute square root of negative bigint");
  }
  if (n < 2n) return n;
  let x0 = 1n << BigInt((n.toString(2).length >> 1) + 1);
  let x1 = (x0 + n / x0) >> 1n;
  while (x1 < x0) {
    x0 = x1;
    x1 = (x0 + n / x0) >> 1n;
  }
  return x0;
};

const integerRootCeil = (n: bigint, k: bigint): bigint => {
  if (k === 1n) return n;
  let low = 2n;
  let high = n;
  while (low <= high) {
    const mid = (low + high) >> 1n;
    const power = powBigInt(mid, k);
    if (power === n) {
      return mid;
    }
    if (power < n) {
      low = mid + 1n;
    } else {
      high = mid - 1n;
    }
  }
  return low;
};

/**
 * Checks if n is a perfect power: n = a^b for integers a, b > 1
 * Returns [a, b] if found, null otherwise.
 * Prefers smallest exponent b to minimize application depth.
 *
 * @internal Exported for testing purposes
 */
export function findPerfectPower(
  value: number | bigint,
): [bigint, bigint] | null {
  const n = toBigInt(value);
  if (n < 4n) return null; // 0,1,2,3 are not perfect powers (with b > 1)

  const bitLength = BigInt(n.toString(2).length);
  for (let exponent = 2n; exponent <= bitLength; exponent++) {
    const base = integerRootCeil(n, exponent);
    if (base <= 1n) continue;
    const power = powBigInt(base, exponent);
    if (power === n) {
      return [base, exponent];
    }
    if (base === 2n && exponent === 2n && power > n) {
      // further exponents will only increase the result
      break;
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
export function findFactors(value: number | bigint): [bigint, bigint] | null {
  const n = toBigInt(value);
  if (n < 4n) return null;
  const sqrtN = sqrtBigInt(n);
  for (let a = 2n; a <= sqrtN; a++) {
    if (n % a === 0n) {
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
  | { type: "perfectPower"; base: bigint; exponent: bigint }
  | { type: "composite"; factor1: bigint; factor2: bigint }
  | { type: "prime"; predecessor: bigint };

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
function optimizeChurchN(n: bigint): SKIExpression {
  const cached = churchCache.get(n);
  if (cached !== undefined) {
    return cached;
  }

  const workQueue: bigint[] = [n];
  const deferred: Map<bigint, DeferredComputation> = new Map();
  const analyzed = new Set<bigint>();

  while (workQueue.length > 0) {
    const current = workQueue.pop()!;
    if (churchCache.has(current) || analyzed.has(current)) {
      continue;
    }
    analyzed.add(current);

    if (current === 0n) {
      churchCache.set(current, Zero);
      continue;
    } else if (current === 1n) {
      churchCache.set(current, One);
      continue;
    } else if (current === 2n) {
      if (ChurchTwo === null) {
        ChurchTwo = apply(Succ, One);
      }
      churchCache.set(current, ChurchTwo);
      continue;
    }

    const perfectPower = findPerfectPower(current);
    if (perfectPower !== null) {
      const [base, exponent] = perfectPower;
      deferred.set(current, { type: "perfectPower", base, exponent });
      if (!churchCache.has(base) && !analyzed.has(base)) workQueue.push(base);
      if (!churchCache.has(exponent) && !analyzed.has(exponent)) {
        workQueue.push(exponent);
      }
    } else {
      const factors = findFactors(current);
      if (factors !== null) {
        const [factor1, factor2] = factors;
        deferred.set(current, { type: "composite", factor1, factor2 });
        if (!churchCache.has(factor1) && !analyzed.has(factor1)) {
          workQueue.push(factor1);
        }
        if (!churchCache.has(factor2) && !analyzed.has(factor2)) {
          workQueue.push(factor2);
        }
      } else {
        const predecessor = current - 1n;
        deferred.set(current, { type: "prime", predecessor });
        if (!churchCache.has(predecessor) && !analyzed.has(predecessor)) {
          workQueue.push(predecessor);
        }
      }
    }
  }

  const sortedNumbers = Array.from(deferred.keys()).sort((a, b) =>
    a < b ? -1 : a > b ? 1 : 0
  );

  for (const num of sortedNumbers) {
    if (churchCache.has(num)) continue; // Already resolved

    const comp = deferred.get(num);
    if (!comp) {
      throw new Error(`Missing deferred computation for ${num}`);
    }

    let result: SKIExpression;

    switch (comp.type) {
      case "perfectPower": {
        const baseExpr = optimizeChurchN(comp.base);
        const expExpr = optimizeChurchN(comp.exponent);
        result = apply(expExpr, baseExpr);
        break;
      }
      case "composite": {
        const factor1Expr = optimizeChurchN(comp.factor1);
        const factor2Expr = optimizeChurchN(comp.factor2);
        result = applyMany(B, factor1Expr, factor2Expr);
        break;
      }
      case "prime": {
        const predExpr = optimizeChurchN(comp.predecessor);
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
 * Creates a Church-encoded numeral from an integer.
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
 * @param value a non-negative integer
 * @returns an extensionally equivalent Church numeral as an SKI expression
 * @throws Error if the input is negative or non-integral
 */
export const ChurchN = (value: number | bigint): SKIExpression => {
  const n = toBigInt(value);
  if (n < 0n) {
    throw new Error("only non-negative integers are supported");
  }
  return optimizeChurchN(n);
};

/**
 * Evaluates a Church numeral SKI expression to a JavaScript bigint using the optimized native path.
 *
 * Useful for testing numeric results of SKI computations via Church encoding.
 * Returns bigint to support unbounded natural numbers.
 */
export const UnChurchNumber = (exp: SKIExpression): bigint => {
  return unChurchNumberNative(exp);
};

/**
 * UnChurchBoolean applies the Church boolean expression to two Church numerals
 * (here ChurchN(1) and ChurchN(0)) and then reduces and uses UnChurch to obtain a bigint.
 * If the result is 1, then the Church boolean was true; if 0, then it was false.
 */
export const UnChurchBoolean = (expr: SKIExpression): boolean => {
  // Apply the Church boolean to ChurchN(1) (for true) and ChurchN(0) (for false)
  // `arenaEvaluator` is the single-threaded evaluator and returns synchronously.
  const testExpr = arenaEvaluator.reduce(
    applyMany(expr, ChurchN(1), ChurchN(0)),
  ) as SKIExpression;
  return UnChurchNumber(testExpr) === 1n;
};

export const ChurchB = (b: boolean): SKIExpression => b ? True : False;
