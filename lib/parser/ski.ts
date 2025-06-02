import type { SKIExpression } from "../ski/expression.ts";
import {
  consume,
  matchLP,
  matchRP,
  type ParserState,
  peek,
} from "./parserState.ts";
import { ParseError } from "./parseError.ts";
import { parseWithEOF } from "./eof.ts";
import { cons } from "../cons.ts";
import { type SKITerminalSymbol, term } from "../ski/terminal.ts";

/**
 * Parses a chain of SKI atomic terms (term { term }).
 * For example, the input "SII" will be parsed as:
 *    mkApp(mkApp(S, I), I)
 *
 * Returns a tuple of the literal parsed, the SKI expression, and the updated state.
 */
function parseSKIChain(rdb: ParserState): [string, SKIExpression, ParserState] {
  let [lit, expr, state] = parseAtomicSKI(rdb);
  for (;;) {
    const [next, newState] = peek(state);
    if (
      next === null ||
      (next !== "(" && !["S", "K", "I"].includes(next.toUpperCase()))
    ) {
      return [lit, expr, newState];
    }
    const [nextLit, nextExpr, updatedState] = parseAtomicSKI(newState);
    lit = `${lit} ${nextLit}`;
    expr = cons(expr, nextExpr);
    state = updatedState;
  }
}

/**
 * Parses an atomic SKI term.
 * This is either one of the terminals S, K, I or a parenthesized SKI expression.
 *
 * Returns a tuple of the literal parsed, the SKI expression, and the updated state.
 */
export function parseAtomicSKI(
  rdb: ParserState,
): [string, SKIExpression, ParserState] {
  const [peeked, state] = peek(rdb);
  if (peeked === "(") {
    // Parse a parenthesized expression.
    const stateAfterLP = matchLP(state);
    // Inside parentheses we parse a whole chain.
    const [innerLit, innerExpr, stateAfterChain] = parseSKIChain(stateAfterLP);
    const stateAfterRP = matchRP(stateAfterChain);
    return [`(${innerLit})`, innerExpr, stateAfterRP];
  } else if (
    peeked &&
    (peeked.toUpperCase() === "S" ||
      peeked.toUpperCase() === "K" ||
      peeked.toUpperCase() === "I")
  ) {
    const token = peeked.toUpperCase();
    const stateAfterConsume = consume(state);
    return [peeked, term(token as SKITerminalSymbol), stateAfterConsume];
  } else {
    const unexpected = peeked === null ? "EOF" : `"${peeked}"`;
    throw new ParseError(
      `unexpected token ${unexpected} when expecting an SKI term`,
    );
  }
}

/**
 * Parses a full SKI expression.
 * (This is just a wrapper around parseSKIChain, which implements the left‐associative application.)
 *
 * Returns a tuple of the literal parsed, the SKI expression, and the updated state.
 */
export function parseSKIInternal(
  rdb: ParserState,
): [string, SKIExpression, ParserState] {
  return parseSKIChain(rdb);
}

/**
 * Parses an input string into an SKI expression.
 */
export function parseSKI(input: string): SKIExpression {
  const [, expr] = parseWithEOF(input, parseSKIInternal);
  return expr;
}
