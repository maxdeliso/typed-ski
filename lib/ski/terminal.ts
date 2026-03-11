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
  /** The B combinator (composition combinator). */
  B = "B",
  /** The C combinator (exchange combinator). */
  C = "C",
  /** The S' combinator (Turner PSI). */
  SPrime = "P",
  /** The B' combinator (Turner B-prime). */
  BPrime = "Q",
  /** The C' combinator (Turner GAMMA). */
  CPrime = "R",
  /** Read a single byte (brainf***-style ","). */
  ReadOne = ",",
  /** Write a single byte (brainf***-style "."). */
  WriteOne = ".",
  /** eqU8 : U8 -> U8 -> Bool (native intrinsic). */
  EqU8 = "E",
  /** ltU8 : U8 -> U8 -> Bool (native intrinsic). */
  LtU8 = "L",
  /** divU8 : U8 -> U8 -> U8 (native intrinsic). */
  DivU8 = "D",
  /** modU8 : U8 -> U8 -> U8 (native intrinsic). */
  ModU8 = "M",
  /** addU8 : U8 -> U8 -> U8 (native intrinsic). */
  AddU8 = "A",
  SubU8 = "O",
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
 * The B combinator terminal node.
 *
 * The B combinator is the composition combinator:
 * B x y z = x (y z)
 */
export const B: SKITerminal = term(SKITerminalSymbol.B);

/**
 * The C combinator terminal node.
 *
 * The C combinator is the exchange combinator:
 * C x y z = x z y
 */
export const C: SKITerminal = term(SKITerminalSymbol.C);

/**
 * The S' combinator terminal node (Turner PSI).
 */
export const SPrime: SKITerminal = term(SKITerminalSymbol.SPrime);

/**
 * The B' combinator terminal node (Turner B-prime).
 */
export const BPrime: SKITerminal = term(SKITerminalSymbol.BPrime);

/**
 * The C' combinator terminal node (Turner GAMMA).
 */
export const CPrime: SKITerminal = term(SKITerminalSymbol.CPrime);

/**
 * The readOne terminal node (input).
 */
export const ReadOne: SKITerminal = term(SKITerminalSymbol.ReadOne);

/**
 * The writeOne terminal node (output).
 */
export const WriteOne: SKITerminal = term(SKITerminalSymbol.WriteOne);

/**
 * The eqU8 intrinsic terminal (native byte equality).
 */
export const EqU8: SKITerminal = term(SKITerminalSymbol.EqU8);

/**
 * The ltU8 intrinsic terminal (native byte less-than).
 */
export const LtU8: SKITerminal = term(SKITerminalSymbol.LtU8);

/**
 * The divU8 intrinsic terminal (native byte division).
 */
export const DivU8: SKITerminal = term(SKITerminalSymbol.DivU8);

/**
 * The modU8 intrinsic terminal (native byte modulo).
 */
export const ModU8: SKITerminal = term(SKITerminalSymbol.ModU8);

/**
 * The addU8 intrinsic terminal (native byte addition).
 */
export const AddU8: SKITerminal = term(SKITerminalSymbol.AddU8);

/**
 * The subU8 intrinsic terminal (native byte subtraction).
 */
export const SubU8: SKITerminal = term(SKITerminalSymbol.SubU8);
