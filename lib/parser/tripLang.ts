import {
  createParserState,
  matchCh,
  parseIdentifier,
  parseKeyword,
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

export function parseTripLangDefinition(
  state: ParserState,
): [TripLangTerm, ParserState] {
  const [kind, stateAfterKind] = parseKeyword(state, [
    "poly",
    "typed",
    "untyped",
    "combinator",
    "type",
  ]);

  const [name, stateAfterName] = parseIdentifier(stateAfterKind);
  let currentState = skipWhitespace(stateAfterName);
  let type;

  if (kind === "typed") {
    currentState = matchCh(currentState, ":");
    currentState = skipWhitespace(currentState);
    [, type, currentState] = parseArrowType(currentState);
  }

  currentState = skipWhitespace(currentState);
  currentState = matchCh(currentState, "=");
  currentState = skipWhitespace(currentState);

  let term;
  let finalState;
  switch (kind) {
    case "poly":
      [, term, finalState] = parseSystemFTerm(currentState);
      return [{ kind: "poly", name, term }, skipWhitespace(finalState)];

    case "typed":
      [, term, finalState] = parseTypedLambdaInternal(currentState);
      if (type === undefined) {
        throw new ParseError("expected type for typed definition");
      }
      return [{ kind: "typed", name, type, term }, skipWhitespace(finalState)];

    case "untyped":
      [, term, finalState] = parseUntypedLambdaInternal(currentState);
      return [{ kind: "untyped", name, term }, skipWhitespace(finalState)];

    case "combinator":
      [, term, finalState] = parseSKIInternal(currentState);
      return [{ kind: "combinator", name, term }, skipWhitespace(finalState)];

    case "type":
      [, type, finalState] = parseSystemFType(currentState);
      return [{ kind: "type", name, type }, skipWhitespace(finalState)];

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
