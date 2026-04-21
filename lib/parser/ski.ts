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
  matchCh,
  matchLP,
  matchRP,
  parseNumericLiteral,
  type ParserState,
  peek,
  withParserState,
} from "./parserState.ts";
import { ParseError } from "./parseError.ts";
import { parseWithEOF } from "./eof.ts";
import {
  immediate,
  SKIImmediateFamily,
  SKITerminalSymbol,
  term,
} from "../ski/terminal.ts";

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
  E: SKITerminalSymbol.EqU8,
  L: SKITerminalSymbol.LtU8,
  D: SKITerminalSymbol.DivU8,
  M: SKITerminalSymbol.ModU8,
  A: SKITerminalSymbol.AddU8,
  O: SKITerminalSymbol.SubU8,
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

function immediateFamilyFromToken(
  tok: string | null,
): SKIImmediateFamily | null {
  if (tok === null) return null;
  if (tok === "J" || tok === "j") return SKIImmediateFamily.J;
  if (tok === "V" || tok === "v") return SKIImmediateFamily.V;
  return null;
}

function isAtomStart(tok: string | null): boolean {
  return (
    tok === "(" ||
    tok === "#" ||
    isSymbol(tok) ||
    immediateFamilyFromToken(tok) !== null
  );
}

/** Parses #u8(<decimal 0..255>) and returns [literal string, SKI u8 expr, state]. */
function parseU8Literal(
  state: ParserState,
): [string, SKIExpression, ParserState] {
  const s1 = matchCh(state, "#");
  const s2 = matchCh(s1, "u");
  const s3 = matchCh(s2, "8");
  const s4 = matchLP(s3);
  const [lit, num, s5] = parseNumericLiteral(s4);
  const value = Number(num);
  if (value < 0 || value > 255) {
    throw new ParseError(
      withParserState(s5, `#u8 value must be 0..255, got ${value}`),
    );
  }
  const s6 = matchRP(s5);
  const literal = `#u8(${lit})`;
  return [literal, { kind: "u8", value }, s6];
}

function parseImmediateLiteral(
  state: ParserState,
): [string, SKIExpression, ParserState] {
  const [peeked, skipped] = peek(state);
  const family = immediateFamilyFromToken(peeked);
  if (family === null) {
    throw new ParseError(
      withParserState(skipped, "expected J<n> or V<m> immediate"),
    );
  }

  const afterPrefix = consume(skipped);
  let digits = "";
  let current = afterPrefix;
  while (current.idx < current.buf.length) {
    const ch = current.buf[current.idx]!;
    if (!/^[0-9]$/.test(ch)) break;
    digits += ch;
    current = consume(current);
  }

  if (digits.length === 0) {
    throw new ParseError(
      withParserState(afterPrefix, `expected decimal suffix after '${family}'`),
    );
  }

  const value = Number(digits);
  if (value < 0 || value > 255) {
    throw new ParseError(
      withParserState(
        current,
        `${family} immediate must be 0..255, got ${value}`,
      ),
    );
  }

  const literal = `${family}${digits}`;
  return [literal, immediate(family, value), current];
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
  } else if (peeked === "#") {
    return parseU8Literal(state);
  } else if (immediateFamilyFromToken(peeked) !== null) {
    return parseImmediateLiteral(state);
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

function parseParens(state: ParserState): [string, SKIExpression, ParserState] {
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
