/**
 * SKI expression parser.
 *
 * This module provides parsing functionality for SKI combinator expressions,
 * supporting terminals S, K, I and fully parenthesized applications.
 *
 * @module
 */
import type { SKIExpression } from "../ski/expression.ts";
import { apply } from "../ski/expression.ts";
import {
  consume,
  matchLP,
  matchRP,
  type ParserState,
  peek,
  withParserState,
} from "./parserState.ts";
import { ParseError } from "./parseError.ts";
import { parseWithEOF } from "./eof.ts";
import { SKITerminalSymbol, term } from "../ski/terminal.ts";

const TERMINAL_ALIASES: Record<string, SKITerminalSymbol> = {
  S: SKITerminalSymbol.S,
  K: SKITerminalSymbol.K,
  I: SKITerminalSymbol.I,
  B: SKITerminalSymbol.B,
  C: SKITerminalSymbol.C,
  P: SKITerminalSymbol.SPrime,
  Q: SKITerminalSymbol.BPrime,
  R: SKITerminalSymbol.CPrime,
  ",": SKITerminalSymbol.ReadOne,
  ".": SKITerminalSymbol.WriteOne,
};

function normalizeSymbol(tok: string | null): SKITerminalSymbol | null {
  if (tok === null) return null;
  const upper = tok.toUpperCase();
  if (upper in TERMINAL_ALIASES) return TERMINAL_ALIASES[upper]!;
  if (tok in TERMINAL_ALIASES) return TERMINAL_ALIASES[tok]!;
  return null;
}

function isSymbol(tok: string | null): tok is SKITerminalSymbol {
  return normalizeSymbol(tok) !== null;
}

function isAtomStart(tok: string | null): boolean {
  return tok === "(" || isSymbol(tok);
}

function parseSeq(rdb: ParserState): [string, SKIExpression, ParserState] {
  let [lit, expr, state] = parseAtomicOrParens(rdb);
  let [next, newState] = peek(state);

  while (isAtomStart(next)) {
    const [nextLit, nextExpr, updatedState] = parseAtomicOrParens(newState);
    lit = `${lit} ${nextLit}`;
    expr = apply(expr, nextExpr);
    state = updatedState;
    [next, newState] = peek(state);
  }

  return [lit, expr, newState];
}

function parseAtomicOrParens(
  rdb: ParserState,
): [string, SKIExpression, ParserState] {
  const [peeked, state] = peek(rdb);

  if (peeked === "(") {
    return parseParens(state);
  } else if (isSymbol(peeked)) {
    const token = normalizeSymbol(peeked)!;
    const stateAfterConsume = consume(state);
    return [peeked, term(token), stateAfterConsume];
  } else {
    const unexpected = peeked === null ? "EOF" : `"${peeked}"`;
    throw new ParseError(
      withParserState(
        state,
        `unexpected token ${unexpected} when expecting an SKI term`,
      ),
    );
  }
}

function parseParens(
  state: ParserState,
): [string, SKIExpression, ParserState] {
  const stateAfterLP = matchLP(state);
  const [innerLit, innerExpr, stateAfterChain] = parseSeq(stateAfterLP);
  const stateAfterRP = matchRP(stateAfterChain);
  return [`(${innerLit})`, innerExpr, stateAfterRP];
}

export const parseSKIDelimited = (
  rdb: ParserState,
): [string, SKIExpression, ParserState] => parseSeq(rdb);

/**
 * Parses an input string containing an SKI expression into its AST representation.
 *
 * Accepts terminals S, K, I and fully parenthesized applications.
 *
 * @param input the source string
 * @returns the parsed `SKIExpression`
 * @throws ParseError when the input is not a valid SKI expression
 */
export function parseSKI(input: string): SKIExpression {
  const [, expr] = parseWithEOF(input, parseSKIDelimited);
  return expr;
}
