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
  /** Read a single byte (brainfuck-style ","). */
  ReadOne = ",",
  /** Write a single byte (brainfuck-style "."). */
  WriteOne = ".",
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

/**
 * Creates a terminal node with the specified SKI symbol.
 *
 * @param sym - The SKI terminal symbol to create a node for
 * @returns A terminal node containing the specified symbol
 */
export const term = (sym: SKITerminalSymbol): SKITerminal => ({
  kind: "terminal",
  sym,
});

/**
 * The S combinator terminal node.
 *
 * The S combinator is the substitution combinator that applies three arguments
 * in the pattern: S x y z = x z (y z)
 */
export const S: SKITerminal = term(SKITerminalSymbol.S);

/**
 * The K combinator terminal node.
 *
 * The K combinator is the constant combinator that discards its second argument
 * and returns the first: K x y = x
 */
export const K: SKITerminal = term(SKITerminalSymbol.K);

/**
 * The I combinator terminal node.
 *
 * The I combinator is the identity combinator that returns its argument unchanged:
 * I x = x
 */
export const I: SKITerminal = term(SKITerminalSymbol.I);

/**
 * The readOne terminal node (input).
 */
export const ReadOne: SKITerminal = term(SKITerminalSymbol.ReadOne);

/**
 * The writeOne terminal node (output).
 */
export const WriteOne: SKITerminal = term(SKITerminalSymbol.WriteOne);
