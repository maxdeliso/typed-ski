/**
 * TripLang program parser.
 *
 * This module provides the main parser for TripLang programs, supporting
 * module definitions, imports/exports, and term/type definitions across
 * System F, typed/untyped lambda calculus, SKI combinators, and base types.
 *
 * @module
 */
import {
  createParserState,
  matchCh,
  parseDefinitionKeyword,
  parseIdentifier,
  parseOptionalTypeAnnotation,
  type ParserState,
  remaining,
  skipWhitespace,
} from "./parserState.ts";
import {
  COMBINATOR,
  EXPORT,
  IMPORT,
  MODULE,
  POLY,
  TYPE,
  TYPED,
  UNTYPED,
} from "./definition.ts";

import { ParseError } from "./parseError.ts";
import { parseSystemFTerm } from "./systemFTerm.ts";
import { parseArrowType, parseTypedLambdaInternal } from "./typedLambda.ts";
import { parseUntypedLambdaInternal } from "./untyped.ts";
import { parseSKIDelimited } from "./ski.ts";
import type { TripLangProgram, TripLangTerm } from "../meta/trip.ts";
import { parseSystemFType } from "./systemFType.ts";
import type { BaseType } from "../types/types.ts";
import type { SystemFTerm } from "../terms/systemF.ts";
import type { TypedLambda } from "../types/typedLambda.ts";
import type { UntypedLambda } from "../terms/lambda.ts";
import type { SKIExpression } from "../ski/expression.ts";
import { EQUALS } from "./consts.ts";

export function parseTripLangDefinition(
  state: ParserState,
): [TripLangTerm, ParserState] {
  let currentState: ParserState;
  let type: BaseType | undefined;
  let term:
    | SystemFTerm
    | TypedLambda
    | UntypedLambda
    | SKIExpression
    | BaseType;
  let finalState: ParserState;

  const [kind, stateAfterKind] = parseDefinitionKeyword(state);
  const [name, stateAfterName] = parseIdentifier(stateAfterKind);

  if (kind === MODULE || kind === IMPORT || kind === EXPORT) {
    switch (kind) {
      case MODULE:
        return [{ kind: MODULE, name }, skipWhitespace(stateAfterName)];
      case IMPORT: {
        const [ref, stateAfterRef] = parseIdentifier(stateAfterName);
        return [{ kind: IMPORT, name, ref }, skipWhitespace(stateAfterRef)];
      }
      case EXPORT:
        return [{ kind: EXPORT, name }, skipWhitespace(stateAfterName)];
    }
  }

  currentState = skipWhitespace(stateAfterName);

  if (kind === TYPED) {
    [type, currentState] = parseOptionalTypeAnnotation(
      currentState,
      parseArrowType,
    );
  } else if (kind === POLY) {
    [type, currentState] = parseOptionalTypeAnnotation(
      currentState,
      parseSystemFType,
    );
  }

  currentState = skipWhitespace(currentState);
  currentState = matchCh(currentState, EQUALS);
  currentState = skipWhitespace(currentState);

  switch (kind) {
    case POLY: {
      const [, systemFTerm, finalState] = parseSystemFTerm(currentState);
      return [{
        kind: POLY,
        name,
        type,
        term: systemFTerm,
      }, skipWhitespace(finalState)];
    }

    case TYPED: {
      const [, typedTerm, finalState] = parseTypedLambdaInternal(currentState);
      return [{
        kind: TYPED,
        name,
        type,
        term: typedTerm,
      }, skipWhitespace(finalState)];
    }

    case UNTYPED:
      [, term, finalState] = parseUntypedLambdaInternal(currentState);
      return [{ kind: UNTYPED, name, term }, skipWhitespace(finalState)];

    case COMBINATOR:
      [, term, finalState] = parseSKIDelimited(currentState);
      return [{ kind: COMBINATOR, name, term }, skipWhitespace(finalState)];

    case TYPE:
      [, type, finalState] = parseSystemFType(currentState);
      return [{ kind: TYPE, name, type }, skipWhitespace(finalState)];

    default:
      throw new ParseError(`Unknown definition kind: ${kind}`);
  }
}

/**
 * Parses a TripLang program source string into a `TripLangProgram` AST.
 *
 * Supports module, import/export, and term/type definitions across System F, typed/untyped lambda, SKI, and base types.
 *
 * @param input the program source
 * @returns the parsed program
 * @throws ParseError when the input is not a valid TripLang program
 */
export function parseTripLang(input: string): TripLangProgram {
  const terms: TripLangTerm[] = [];
  let state = createParserState(input);

  for (;;) {
    state = skipWhitespace(state);

    const [hasRemaining] = remaining(state);

    if (!hasRemaining) break;

    const [term, stateAfterTerm] = parseTripLangDefinition(state);
    terms.push(term);
    state = skipWhitespace(stateAfterTerm);
  }

  return { kind: "program", terms };
}
