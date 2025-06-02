import {
  consume,
  matchLP,
  matchRP,
  parseIdentifier,
  type ParserState,
  peek,
} from "./parserState.ts";
import { ParseError } from "./parseError.ts";
import { arrow, type BaseType, mkTypeVariable } from "../types/types.ts";
import { parseWithEOF } from "./eof.ts";

/**
 * Parses a "simple" type.
 * Simple types are either a variable or a parenthesized type.
 *
 * Returns a triple: [literal, BaseType, updatedState]
 */
export function parseSimpleType(
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
      throw new ParseError("expected ')' after type expression");
    }
    const stateAfterRP = matchRP(sAfterInner);
    return [`(${innerLit})`, innerType, stateAfterRP];
  } else {
    const [varLit, stateAfterVar] = parseIdentifier(s);
    return [varLit, mkTypeVariable(varLit), stateAfterVar];
  }
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
  const [leftLit, leftType, stateAfterLeft] = parseSimpleType(state);
  const [next, sAfterLeft] = peek(stateAfterLeft);
  if (next === "→") {
    const stateAfterArrow = consume(sAfterLeft);
    const [rightLit, rightType, stateAfterRight] = parseArrowType(
      stateAfterArrow,
    );
    return [
      `${leftLit}→${rightLit}`,
      arrow(leftType, rightType),
      stateAfterRight,
    ];
  } else {
    return [leftLit, leftType, stateAfterLeft];
  }
}

/**
 * Parses a complete type from an input string.
 */
export function parseType(input: string): [string, BaseType] {
  const [lit, type] = parseWithEOF(input, parseArrowType);
  return [lit, type];
}
