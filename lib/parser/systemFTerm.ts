/**
 * System F term parser.
 *
 * This module provides parsing functionality for System F (polymorphic lambda calculus)
 * terms, including variables, abstractions, type abstractions, and applications.
 *
 * @module
 */
import { ParseError } from "./parseError.ts";
import {
  isDigit,
  matchCh,
  matchLP,
  matchRP,
  parseIdentifier,
  parseNumericLiteral,
  peek,
} from "./parserState.ts";
import type { ParserState } from "./parserState.ts";
import { parseSystemFType } from "./systemFType.ts";
import { parseWithEOF } from "./eof.ts";
import {
  mkSystemFAbs,
  mkSystemFTAbs,
  mkSystemFTypeApp,
  mkSystemFVar,
  type SystemFTerm,
} from "../terms/systemF.ts";
import { makeNatLiteralIdentifier } from "../consts/nat.ts";
import { parseChain } from "./chain.ts";
import { createSystemFApplication } from "../terms/systemF.ts";

/**
 * Parses an atomic System F term.
 * Atomic terms can be:
 *   - A term abstraction: "λx: T. t"
 *   - A type abstraction: "ΛX. t"
 *   - A parenthesized term: "(" t ")"
 *   - A type application: "t [T]"
 *   - A variable: e.g. "x"
 *
 * Returns a triple: [literal, SystemFTerm, updated state]
 */
export function parseAtomicSystemFTerm(
  state: ParserState,
): [string, SystemFTerm, ParserState] {
  const [ch, currentState] = peek(state);

  if (ch === "λ") {
    const stateAfterLambda = matchCh(currentState, "λ");
    const [varLit, stateAfterVar] = parseIdentifier(stateAfterLambda);
    const stateAfterColon = matchCh(stateAfterVar, ":");
    const [typeLit, typeAnnotation, stateAfterType] = parseSystemFType(
      stateAfterColon,
    );
    const stateAfterDot = matchCh(stateAfterType, ".");
    const [bodyLit, bodyTerm, stateAfterBody] = parseSystemFTerm(stateAfterDot);
    return [
      `λ${varLit}:${typeLit}.${bodyLit}`,
      mkSystemFAbs(varLit, typeAnnotation, bodyTerm),
      stateAfterBody,
    ];
  } else if (ch === "(") {
    const stateAfterLP = matchLP(state);
    const [innerLit, innerTerm, stateAfterTerm] = parseSystemFTerm(
      stateAfterLP,
    );
    const stateAfterRP = matchRP(stateAfterTerm);
    return [`(${innerLit})`, innerTerm, stateAfterRP];
  } else if (ch === "Λ") {
    const stateAfterLambdaT = matchCh(state, "Λ");
    const [typeVar, stateAfterVar] = parseIdentifier(stateAfterLambdaT);
    const stateAfterDot = matchCh(stateAfterVar, ".");
    const [bodyLit, bodyTerm, stateAfterBody] = parseSystemFTerm(stateAfterDot);
    return [
      `Λ${typeVar}.${bodyLit}`,
      mkSystemFTAbs(typeVar, bodyTerm),
      stateAfterBody,
    ];
  } else if (isDigit(ch)) {
    const [literal, value, stateAfterLiteral] = parseNumericLiteral(state);
    return [
      literal,
      mkSystemFVar(makeNatLiteralIdentifier(value)),
      stateAfterLiteral,
    ];
  } else if (ch !== null && /[a-zA-Z]/.test(ch)) {
    const [varLit, stateAfterVar] = parseIdentifier(state);
    const [nextCh, stateAfterPeek] = peek(stateAfterVar);
    if (nextCh === "[") {
      const stateAfterLBracket = matchCh(stateAfterPeek, "[");
      const [typeLit, typeArg, stateAfterType] = parseSystemFType(
        stateAfterLBracket,
      );
      const stateAfterRBracket = matchCh(stateAfterType, "]");
      return [
        `${varLit}[${typeLit}]`,
        mkSystemFTypeApp({ kind: "systemF-var", name: varLit }, typeArg),
        stateAfterRBracket,
      ];
    }
    return [varLit, { kind: "systemF-var", name: varLit }, stateAfterVar];
  } else {
    throw new ParseError(
      `unexpected end-of-input while parsing atomic term: ${ch ?? "EOF"}`,
    );
  }
}

/**
 * Parses a complete System F term, handling both term and type application.
 * Returns a triple: [literal, SystemFTerm, updated state]
 */
export function parseSystemFTerm(
  state: ParserState,
): [string, SystemFTerm, ParserState] {
  return parseChain<SystemFTerm>(
    state,
    parseAtomicSystemFTerm,
    createSystemFApplication,
  );
}

/**
 * Parses an input string into a System F term with EOF checking.
 */
export function parseSystemF(input: string): [string, SystemFTerm] {
  const [lit, term] = parseWithEOF(input, parseSystemFTerm);
  return [lit, term];
}
