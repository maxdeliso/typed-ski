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

import { ParseError } from "./parseError.ts";
import { parseSystemFTerm } from "./systemFTerm.ts";
import { parseArrowType, parseTypedLambdaInternal } from "./typedLambda.ts";
import { parseUntypedLambdaInternal } from "./untyped.ts";
import { parseSKIInternal } from "./ski.ts";
import type { TripLangProgram, TripLangTerm } from "../meta/trip.ts";
import { parseSystemFType } from "./systemFType.ts";
import type { BaseType } from "../types/types.ts";
import type { SystemFTerm } from "../terms/systemF.ts";
import type { TypedLambda } from "../types/typedLambda.ts";
import type { UntypedLambda } from "../terms/lambda.ts";
import type { SKIExpression } from "../ski/expression.ts";

export const WHITESPACE_REGEX = /\s/;
export const IDENTIFIER_CHAR_REGEX = /[a-zA-Z0-9_]/;

export const LEFT_PAREN = "(";
export const RIGHT_PAREN = ")";
export const COLON = ":";
export const EQUALS = "=";

const POLY = "poly" as const;
const TYPED = "typed" as const;
const UNTYPED = "untyped" as const;
const COMBINATOR = "combinator" as const;
const TYPE = "type" as const;
const MODULE = "module" as const;
const IMPORT = "import" as const;
const EXPORT = "export" as const;

export const DEFINITION_KEYWORDS = [
  POLY,
  TYPED,
  UNTYPED,
  COMBINATOR,
  TYPE,
  MODULE,
  IMPORT,
  EXPORT,
] as const;

export type DefinitionKind = typeof DEFINITION_KEYWORDS[number];

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
    case POLY:
      [, term, finalState] = parseSystemFTerm(currentState);
      return [{ kind: POLY, name, type, term }, skipWhitespace(finalState)];

    case TYPED:
      [, term, finalState] = parseTypedLambdaInternal(currentState);
      return [{ kind: TYPED, name, type, term }, skipWhitespace(finalState)];

    case UNTYPED:
      [, term, finalState] = parseUntypedLambdaInternal(currentState);
      return [{ kind: UNTYPED, name, term }, skipWhitespace(finalState)];

    case COMBINATOR:
      [, term, finalState] = parseSKIInternal(currentState);
      return [{ kind: COMBINATOR, name, term }, skipWhitespace(finalState)];

    case TYPE:
      [, type, finalState] = parseSystemFType(currentState);
      return [{ kind: TYPE, name, type }, skipWhitespace(finalState)];

    default:
      throw new ParseError(`Unknown definition kind: ${kind}`);
  }
}

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
