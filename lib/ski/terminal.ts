/**
 * SKI terminal symbol definitions.
 *
 * This module defines the three fundamental SKI combinator symbols (S, K, I)
 * and provides constructors for creating terminal nodes.
 *
 * @module
 */
export enum SKITerminalSymbol {
  /** The S combinator (substitution combinator). */
  S = "S",
  /** The K combinator (constant combinator). */
  K = "K",
  /** The I combinator (identity combinator). */
  I = "I",
}

/**
 * Represents a terminal symbol in an SKI expression.
 *
 * Terminal symbols are the atomic building blocks of SKI combinator expressions,
 * consisting of the three fundamental combinators: S, K, and I.
 */
export interface SKITerminal {
  kind: "terminal";
  sym: SKITerminalSymbol;
}

export const term = (sym: SKITerminalSymbol): SKITerminal => ({
  kind: "terminal",
  sym,
});

export const S: SKITerminal = term(SKITerminalSymbol.S);
export const K: SKITerminal = term(SKITerminalSymbol.K);
export const I: SKITerminal = term(SKITerminalSymbol.I);
