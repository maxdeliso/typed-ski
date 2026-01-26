/**
 * Untyped lambda calculus parser.
 *
 * This module provides parsing functionality for untyped lambda calculus
 * terms, including variables, abstractions, and applications.
 *
 * @module
 */
import { mkUntypedAbs, mkVar, type UntypedLambda } from "../terms/lambda.ts";
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
import { makeUntypedChurchNumeral } from "../consts/nat.ts";
import { parseChain } from "./chain.ts";
import { createApplication } from "../terms/lambda.ts";
import { parseWithEOF } from "./eof.ts";

/**
 * Parses an untyped lambda term (including applications) by chaining
 * together atomic terms.
 *
 * Returns a triple: [literal, UntypedLambda, updatedState]
 */
export function parseUntypedLambdaInternal(
  state: ParserState,
): [string, UntypedLambda, ParserState] {
  return parseChain<UntypedLambda>(
    state,
    parseAtomicUntypedLambda,
    createApplication,
  );
}

/**
 * Parses an atomic untyped lambda term, tracking the literal substring precisely.
 */
export function parseAtomicUntypedLambda(
  state: ParserState,
): [string, UntypedLambda, ParserState] {
  const [peeked, s] = peek(state);

  if (peeked === "\\") {
    let currentState = matchCh(s, "\\");
    const [varLit, stateAfterVar] = parseIdentifier(currentState);
    currentState = matchFatArrow(stateAfterVar);
    const [, bodyTerm, stateAfterBody] = parseUntypedLambdaInternal(
      currentState,
    );
    const literal = s.buf.slice(s.idx, stateAfterBody.idx);
    return [
      literal,
      mkUntypedAbs(varLit, bodyTerm),
      stateAfterBody,
    ];
  } else if (peeked === "(") {
    let currentState = matchLP(s);
    const [, innerTerm, stateAfterInner] = parseUntypedLambdaInternal(
      currentState,
    );
    currentState = matchRP(stateAfterInner);
    const fullLiteral = s.buf.slice(s.idx, currentState.idx);
    return [fullLiteral, innerTerm, currentState];
  } else if (isDigit(peeked)) {
    const [literal, value, nextState] = parseNumericLiteral(s);
    return [literal, makeUntypedChurchNumeral(value), nextState];
  } else {
    const [varLit, stateAfterVar] = parseIdentifier(s);
    const fullLiteral = s.buf.slice(s.idx, stateAfterVar.idx);
    return [fullLiteral, mkVar(varLit), stateAfterVar];
  }
}

/**
 * Parses an input string into an untyped lambda term.
 *
 * This function delegates to parseWithEOF, which ensures that all input
 * is consumed by the parser.
 */
export function parseLambda(input: string): [string, UntypedLambda] {
  const [lit, term] = parseWithEOF(input, parseUntypedLambdaInternal);
  return [lit, term];
}
