/**
 * Bin encoding utilities for SKI expressions (Scott-encoded Bin).
 *
 * These helpers mirror the compiler's Scott encoding for:
 *   data Bin = BZ | B0 Bin | B1 Bin
 */
import { arenaEvaluator } from "../evaluator/skiEvaluator.ts";
import { parseSKI } from "../parser/ski.ts";
import {
  apply,
  applyMany,
  equivalent,
  type SKIExpression,
} from "./expression.ts";
import { B, I, S } from "./terminal.ts";

// Scott-encoded constructors (type erasure applied), in SKI form.
const BZ = parseSKI("((B((BI)K))K)");
const B0 = parseSKI(
  "(((P(P(PS)))(K(K((BI)K))))((B((B((BI)K))K))K))",
);
const B1 = parseSKI("(((P(P(PS)))(K(K(KI))))((B((B((BI)K))K))K))");

/**
 * Construct a Bin value as an SKI expression (little-endian bits).
 */
export const BinN = (value: number | bigint): SKIExpression => {
  let n = typeof value === "bigint" ? value : BigInt(value);
  if (n < 0n) {
    throw new Error("BinN expects a non-negative integer");
  }
  let cur: SKIExpression = BZ;
  const bits: number[] = [];
  while (n > 0n) {
    bits.push(Number(n & 1n));
    n >>= 1n;
  }
  for (let i = bits.length - 1; i >= 0; i--) {
    cur = apply(bits[i] === 0 ? B0 : B1, cur);
  }
  return cur;
};

/**
 * Decode a Bin value in normal form back into a bigint.
 */
export const UnBinNumber = (expr: SKIExpression): bigint => {
  const marker0 = I;
  const marker1 = S;
  const marker2 = B;

  let cur: SKIExpression = expr;
  let result = 0n;
  let bit = 1n;

  for (let i = 0; i < 1024; i++) {
    const reduced = arenaEvaluator.reduce(
      applyMany(cur, marker0, marker1, marker2),
    );

    if (equivalent(reduced, marker0)) {
      break;
    }

    if (reduced.kind === "non-terminal") {
      if (equivalent(reduced.lft, marker1)) {
        cur = reduced.rgt;
      } else if (equivalent(reduced.lft, marker2)) {
        result |= bit;
        cur = reduced.rgt;
      } else {
        break;
      }
    } else {
      break;
    }
    bit <<= 1n;
  }

  return result;
};
