/**
 * This module provides parsing functionality for typed lambda calculus expressions.
 * It exports functions to parse typed lambda terms, including abstractions with type annotations,
 * applications, and variables with their associated types.
 *
 * @example
 * ```ts
 * import { parseTypedLambda } from "jsr:@maxdeliso/typed-ski";
 *
 * const [literal, term] = parseTypedLambda("\\x : A => x");
 * console.log(literal); // "\x:A=>x"
 * ```
 *
 * @module
 */

import { mkVar } from "../terms/lambda.ts";
import {
  createTypedApplication,
  mkTypedAbs,
  type TypedLambda,
} from "../types/typedLambda.ts";
import {
  isDigit,
  matchCh,
  matchFatArrow,
  matchLP,
  matchRP,
  parseIdentifier,
  parseNumericLiteral,
  type ParserState,
  peek,
} from "./parserState.ts";
import { parseChain } from "./chain.ts";
import { parseArrowType } from "./type.ts";
import { parseWithEOF } from "./eof.ts";
import { ParseError } from "./parseError.ts";
import { makeTypedChurchNumeral } from "../types/natLiteral.ts";
import { BACKSLASH } from "./tripLang.ts";

/**
 * Parses an atomic typed lambda term.
 * Atomic terms can be:
 *   - A typed lambda abstraction: "\x : <type> => <body>"
 *   - A parenthesized term: "(" <term> ")"
 *   - A variable: e.g. "x"
 *
 * Returns a triple: [literal, TypedLambda, updated ParserState]
 */
export function parseAtomicTypedLambda(
  state: ParserState,
): [string, TypedLambda, ParserState] {
  const [peeked, s] = peek(state);

  if (peeked === BACKSLASH) {
    const stateAfterLambda = matchCh(s, BACKSLASH);
    const [next] = peek(stateAfterLambda);
    if (next === ":") {
      throw new ParseError("expected an identifier");
    }
    const [varLit, stateAfterVar] = parseIdentifier(stateAfterLambda);
    const stateAfterColon = matchCh(stateAfterVar, ":");
    const [typeLit, ty, stateAfterType] = parseArrowType(stateAfterColon);
    const stateAfterArrow = matchFatArrow(stateAfterType);
    const [bodyLit, bodyTerm, stateAfterBody] = parseTypedLambdaInternal(
      stateAfterArrow,
    );
    return [
      `${BACKSLASH}${varLit}:${typeLit}=>${bodyLit}`,
      mkTypedAbs(varLit, ty, bodyTerm),
      stateAfterBody,
    ];
  } else if (peeked === "(") {
    // Parse a parenthesized term.
    const stateAfterLP = matchLP(s);
    const [innerLit, innerTerm, stateAfterInner] = parseTypedLambdaInternal(
      stateAfterLP,
    );
    const stateAfterRP = matchRP(stateAfterInner);
    return [`(${innerLit})`, innerTerm, stateAfterRP];
  } else if (isDigit(peeked)) {
    const [literal, value, nextState] = parseNumericLiteral(s);
    return [literal, makeTypedChurchNumeral(value), nextState];
  } else {
    const [varLit, stateAfterVar] = parseIdentifier(s);
    return [varLit, mkVar(varLit), stateAfterVar];
  }
}

/**
 * Parses a typed lambda term (handling applications by chaining together atomic terms).
 *
 * Returns a triple: [literal, TypedLambda, updated ParserState]
 */
export function parseTypedLambdaInternal(
  state: ParserState,
): [string, TypedLambda, ParserState] {
  return parseChain<TypedLambda>(
    state,
    parseAtomicTypedLambda,
    createTypedApplication,
  );
}

/**
 * Parses an input string into a typed lambda term.
 * Uses parseWithEOF to ensure the entire input is consumed.
 *
 * Returns a pair: [literal, TypedLambda]
 */
export function parseTypedLambda(input: string): [string, TypedLambda] {
  const [lit, term] = parseWithEOF(input, parseTypedLambdaInternal);
  return [lit, term];
}

export { parseArrowType };
