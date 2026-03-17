/**
 * Random SKI expression generation.
 *
 * This module provides functionality for generating random SKI expressions
 * of specified sizes using a random seed for reproducible results.
 *
 * @module
 */
import type { SKIExpression } from "./expression.ts";
import { apply } from "./expression.ts";
import {
  AddU8,
  B,
  BPrime,
  C,
  CPrime,
  DivU8,
  EqU8,
  I,
  K,
  LtU8,
  ModU8,
  ReadOne,
  S,
  type SKITerminal,
  SKITerminalSymbol,
  SPrime,
  SubU8,
  WriteOne,
} from "./terminal.ts";

const TERMINAL_BY_SYMBOL: Record<SKITerminalSymbol, SKITerminal> = {
  [SKITerminalSymbol.S]: S,
  [SKITerminalSymbol.K]: K,
  [SKITerminalSymbol.I]: I,
  [SKITerminalSymbol.B]: B,
  [SKITerminalSymbol.C]: C,
  [SKITerminalSymbol.SPrime]: SPrime,
  [SKITerminalSymbol.BPrime]: BPrime,
  [SKITerminalSymbol.CPrime]: CPrime,
  [SKITerminalSymbol.ReadOne]: ReadOne,
  [SKITerminalSymbol.WriteOne]: WriteOne,
  [SKITerminalSymbol.EqU8]: EqU8,
  [SKITerminalSymbol.LtU8]: LtU8,
  [SKITerminalSymbol.DivU8]: DivU8,
  [SKITerminalSymbol.ModU8]: ModU8,
  [SKITerminalSymbol.AddU8]: AddU8,
  [SKITerminalSymbol.SubU8]: SubU8,
};

const ALL_RANDOM_TERMINAL_SYMBOLS = Object.values(
  SKITerminalSymbol,
) as SKITerminalSymbol[];

const PURE_RANDOM_TERMINAL_SYMBOLS = ALL_RANDOM_TERMINAL_SYMBOLS.filter(
  (sym) =>
    sym !== SKITerminalSymbol.ReadOne &&
    sym !== SKITerminalSymbol.WriteOne,
);

export interface RandTerminalOptions {
  /**
   * Include effectful IO terminals in the random pool.
   *
   * By default, random generation stays in the pure subset so callers that
   * reduce expressions do not accidentally produce control pointers.
   */
  includeEffects?: boolean;
}

/**
 * Simple interface for random number generation.
 * This allows the generator to work with any random number source
 * without bundling specific dependencies.
 */
export interface RandomSource {
  /** Returns a random integer between min (inclusive) and max (inclusive) */
  intBetween(min: number, max: number): number;
}

export const randExpression = (
  rs: RandomSource,
  n: number,
  options?: RandTerminalOptions,
): SKIExpression => {
  if (n <= 0) {
    throw new Error("A valid expression must contain at least one symbol.");
  }

  let result: SKIExpression = randTerminal(rs, options);

  for (let i = 0; i < n - 1; i++) {
    result = randomInsert(rs, result, randTerminal(rs, options));
  }

  return result;
};

const randomInsert = (
  randomSeed: RandomSource,
  expr: SKIExpression,
  term: SKITerminal,
): SKIExpression => {
  const direction = randomSeed.intBetween(0, 1) === 1;

  if (expr.kind === "terminal") {
    if (direction) {
      return apply(expr, term);
    } else {
      return apply(term, expr);
    }
  }
  if (expr.kind === "u8") {
    if (direction) {
      return apply(expr, term);
    } else {
      return apply(term, expr);
    }
  }
  return apply(
    direction ? randomInsert(randomSeed, expr.lft, term) : expr.lft,
    direction ? expr.rgt : randomInsert(randomSeed, expr.rgt, term),
  );
};

/**
 * @param rs the random source to use.
 * @param options whether to include effectful terminals in the random pool.
 * @returns a randomly selected terminal symbol.
 */
export function randTerminal(
  rs: RandomSource,
  options?: RandTerminalOptions,
): SKITerminal {
  const symbols = options?.includeEffects
    ? ALL_RANDOM_TERMINAL_SYMBOLS
    : PURE_RANDOM_TERMINAL_SYMBOLS;
  const sym = symbols[rs.intBetween(0, symbols.length - 1)];
  if (sym === undefined) {
    throw new Error("Random terminal selection failed");
  }
  return TERMINAL_BY_SYMBOL[sym];
}
