import { forall } from "../types/systemF.ts";
import { arrow, type BaseType, mkTypeVariable } from "../types/types.ts";
import { ParseError } from "./parseError.ts";
import {
  matchCh,
  matchLP,
  matchRP,
  parseIdentifier,
  type ParserState,
  peek,
} from "./parserState.ts";

/**
 * Parses a System F type.
 *
 * Grammar:
 *   Type       ::= "∀" typeVar "." Type
 *                | ArrowType
 *
 *   ArrowType  ::= SimpleType ("→" Type)?
 *
 *   SimpleType ::= type-variable | "(" Type ")"
 *
 * Returns a triple: [literal, SystemFType, updatedState]
 */
export function parseSystemFType(
  state: ParserState,
): [string, BaseType, ParserState] {
  const [ch, s] = peek(state);
  if (ch === "∀") {
    // Parse universal type: ∀X. T
    const stateAfterForall = matchCh(s, "∀"); // consume '∀'
    const [typeVar, stateAfterVar] = parseIdentifier(stateAfterForall);
    const stateAfterDot = matchCh(stateAfterVar, "."); // expect a dot
    const [bodyLit, bodyType, stateAfterBody] = parseSystemFType(stateAfterDot);
    return [
      `∀${typeVar}.${bodyLit}`,
      forall(typeVar, bodyType),
      stateAfterBody,
    ];
  } else {
    // Parse an arrow type.
    const [leftLit, leftType, stateAfterLeft] = parseSimpleSystemFType(s);
    const [next, sAfterLeft] = peek(stateAfterLeft);
    if (next === "→") {
      const stateAfterArrow = matchCh(sAfterLeft, "→"); // consume the arrow
      const [rightLit, rightType, stateAfterRight] = parseSystemFType(
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
}

/**
 * Parses a simple System F type.
 *
 * SimpleType ::= type-variable | "(" Type ")"
 *
 * Returns a triple: [literal, SystemFType, updatedState]
 */
function parseSimpleSystemFType(
  state: ParserState,
): [string, BaseType, ParserState] {
  const [ch, s] = peek(state);
  if (ch === "(") {
    const stateAfterLP = matchLP(s);
    const [innerLit, innerType, stateAfterInner] = parseSystemFType(
      stateAfterLP,
    );
    const [closing, sAfterInner] = peek(stateAfterInner);
    if (closing !== ")") {
      throw new ParseError("expected ')' after type expression");
    }
    const stateAfterRP = matchRP(sAfterInner);
    return [`(${innerLit})`, innerType, stateAfterRP];
  } else {
    // Must be a type variable (a single letter).
    const [varLit, stateAfterVar] = parseIdentifier(s);
    return [varLit, mkTypeVariable(varLit), stateAfterVar];
  }
}
