/**
 * Simple type parser for arrow types.
 *
 * This module provides parsing functionality for simple types including
 * type variables, parenthesized types, and arrow types with right associativity.
 *
 * @module
 */
import {
  matchArrow,
  matchLP,
  matchRP,
  parseIdentifier,
  type ParserState,
  peek,
  peekArrow,
  skipWhitespace,
  withParserState,
} from "./parserState.ts";
import { ParseError } from "./parseError.ts";
import {
  arrow,
  type BaseType,
  mkTypeVariable,
  typeApp,
} from "../types/types.ts";
import { parseWithEOF } from "./eof.ts";
import {
  ARROW,
  HASH,
  IDENTIFIER_CHAR_REGEX,
  LEFT_PAREN,
  RIGHT_PAREN,
} from "./consts.ts";

/**
 * Parses a "simple" type.
 * Simple types are either a variable or a parenthesized type.
 *
 * Returns a triple: [literal, BaseType, updatedState]
 */
function parseSimpleType(
  state: ParserState,
): [string, BaseType, ParserState] {
  const [ch, s] = peek(state);
  if (ch === "(") {
    // Parenthesized type.
    const stateAfterLP = matchLP(s);
    // Recursively parse a full type inside the parentheses.
    const [innerLit, innerType, stateAfterInner] = parseArrowType(stateAfterLP);
    const [next, sAfterInner] = peek(stateAfterInner);
    if (next !== ")") {
      throw new ParseError(
        withParserState(sAfterInner, "expected ')' after type expression"),
      );
    }
    const stateAfterRP = matchRP(sAfterInner);
    return [`(${innerLit})`, innerType, stateAfterRP];
  } else {
    const [varLit, stateAfterVar] = parseIdentifier(s);
    return [varLit, mkTypeVariable(varLit), stateAfterVar];
  }
}

function isTypeAtomStart(ch: string | null): boolean {
  return ch === LEFT_PAREN || (ch !== null && IDENTIFIER_CHAR_REGEX.test(ch));
}

/**
 * Parses a type application (left-associative).
 *
 * Returns a triple: [literal, BaseType, updatedState]
 */
function parseTypeApplication(
  state: ParserState,
): [string, BaseType, ParserState] {
  const [leftLit, leftType, stateAfterLeft] = parseSimpleType(state);
  let literal = leftLit;
  let resultType = leftType;
  let currentState = stateAfterLeft;

  for (;;) {
    currentState = skipWhitespace(currentState);
    const [nextCh, peekState] = peek(currentState);
    const skipped = currentState.buf.slice(currentState.idx, peekState.idx);
    if (skipped.includes("\n") || skipped.includes("\r")) break;
    if (!isTypeAtomStart(nextCh)) break;
    const [argLit, argType, stateAfterArg] = parseSimpleType(peekState);
    literal = `${literal} ${argLit}`;
    resultType = typeApp(resultType, argType);
    currentState = stateAfterArg;
  }

  return [literal, resultType, currentState];
}

/**
 * Parses an arrow type.
 * This function implements right associativity: it checks for an arrow following a simple type,
 * and if present, recursively parses the right–hand side.
 *
 * Returns a triple: [literal, BaseType, updatedState]
 */
export function parseArrowType(
  state: ParserState,
): [string, BaseType, ParserState] {
  const [leftLit, leftType, stateAfterLeft] = parseTypeApplication(state);
  const [isArrow] = peekArrow(stateAfterLeft);
  if (isArrow) {
    const stateAfterArrow = matchArrow(stateAfterLeft);
    const [rightLit, rightType, stateAfterRight] = parseArrowType(
      stateAfterArrow,
    );
    return [
      `${leftLit}${ARROW}${rightLit}`,
      arrow(leftType, rightType),
      stateAfterRight,
    ];
  } else {
    return [leftLit, leftType, stateAfterLeft];
  }
}

/**
 * Parses an arrow type without type application (useful for data fields).
 */
export function parseArrowTypeNoApp(
  state: ParserState,
): [string, BaseType, ParserState] {
  const [leftLit, leftType, stateAfterLeft] = parseSimpleType(state);
  const [isArrow] = peekArrow(stateAfterLeft);
  if (isArrow) {
    const stateAfterArrow = matchArrow(stateAfterLeft);
    const [rightLit, rightType, stateAfterRight] = parseArrowTypeNoApp(
      stateAfterArrow,
    );
    return [
      `${leftLit}${ARROW}${rightLit}`,
      arrow(leftType, rightType),
      stateAfterRight,
    ];
  }
  return [leftLit, leftType, stateAfterLeft];
}

/**
 * Parses a complete type from an input string.
 */
export function parseType(input: string): [string, BaseType] {
  const [lit, type] = parseWithEOF(input, parseArrowType);
  return [lit, type];
}

/**
 * Unparses a base type into a compact ASCII string.
 * @param ty the type to unparse
 * @returns a human-readable string representation
 */
export function unparseType(ty: BaseType): string {
  // Formats either a type variable, a forall, or an arrow type using ASCII.
  if (ty.kind === "type-var") {
    return ty.typeName;
  } else if (ty.kind === "type-app") {
    const fn = ty.fn.kind === "type-var" || ty.fn.kind === "type-app"
      ? unparseType(ty.fn)
      : `${LEFT_PAREN}${unparseType(ty.fn)}${RIGHT_PAREN}`;
    const arg = ty.arg.kind === "type-var"
      ? unparseType(ty.arg)
      : `${LEFT_PAREN}${unparseType(ty.arg)}${RIGHT_PAREN}`;
    return `${fn} ${arg}`;
  } else if (ty.kind === "forall") {
    return `${HASH}${ty.typeVar}${ARROW}${unparseType(ty.body)}`;
  } else {
    return `${LEFT_PAREN}${unparseType(ty.lft)}${ARROW}${
      unparseType(ty.rgt)
    }${RIGHT_PAREN}`;
  }
}
