/**
 * TripLang program parser.
 *
 * This module provides the main parser for TripLang programs, supporting
 * module definitions, imports/exports, and term/type definitions across
 * System F, typed/untyped lambda calculus, SKI combinators, and base types.
 *
 * Import/Export Syntax:
 * - Import: "import <module> <symbol>" (e.g., "import Prelude zero")
 *   Parses to: {name: moduleName, ref: symbolName}
 * - Export: "export <symbol>" (e.g., "export main")
 *   Parses to: {name: symbolName}
 *
 * Arrow Syntax:
 * - Type arrows use "->": "T -> U" means function type from T to U
 * - Term arrows use "=>": "\\x => body" or "match x { | C => body }"
 *
 * @module
 */
import {
  createParserState,
  isAtDefinitionKeywordLine,
  matchCh,
  parseDefinitionKeyword,
  parseIdentifier,
  parseOptionalTypeAnnotation,
  type ParserState,
  peek,
  remaining,
  skipWhitespace,
  withParserState,
} from "./parserState.ts";
import {
  COMBINATOR,
  DATA,
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
import { parseArrowTypeNoApp } from "./type.ts";
import type {
  DataDefinition,
  TripLangProgram,
  TripLangTerm,
} from "../meta/trip.ts";
import { parseSystemFType } from "./systemFType.ts";
import type { BaseType } from "../types/types.ts";
import type { SystemFTerm } from "../terms/systemF.ts";
import type { TypedLambda } from "../types/typedLambda.ts";
import type { UntypedLambda } from "../terms/lambda.ts";
import type { SKIExpression } from "../ski/expression.ts";
import { EQUALS, PIPE } from "./consts.ts";

function parseDataDefinition(
  state: ParserState,
): [DataDefinition, ParserState] {
  const [name, stateAfterName] = parseIdentifier(state);
  let currentState = skipWhitespace(stateAfterName);
  const typeParams: string[] = [];

  for (;;) {
    const [nextCh] = peek(currentState);
    if (nextCh === EQUALS) {
      break;
    }
    const [param, stateAfterParam] = parseIdentifier(currentState);
    typeParams.push(param);
    currentState = skipWhitespace(stateAfterParam);
  }

  currentState = matchCh(currentState, EQUALS);
  currentState = skipWhitespace(currentState);

  const constructors: DataDefinition["constructors"] = [];
  for (;;) {
    currentState = skipWhitespace(currentState);
    const [hasRemaining] = remaining(currentState);
    if (!hasRemaining || isAtDefinitionKeywordLine(currentState)) {
      break;
    }
    const [firstCh, afterPeek] = peek(currentState);
    if (firstCh === PIPE) {
      currentState = skipWhitespace(matchCh(afterPeek, PIPE));
    }
    const [ctorName, stateAfterCtor] = parseIdentifier(currentState);
    currentState = skipWhitespace(stateAfterCtor);

    const fields: BaseType[] = [];
    for (;;) {
      currentState = skipWhitespace(currentState);
      const [nextCh] = peek(currentState);
      if (
        nextCh === PIPE ||
        nextCh === null ||
        isAtDefinitionKeywordLine(currentState)
      ) {
        break;
      }
      const [, fieldType, stateAfterType] = parseArrowTypeNoApp(currentState);
      fields.push(fieldType);
      currentState = skipWhitespace(stateAfterType);
    }

    constructors.push({ name: ctorName, fields });

    const [nextCh, stateAfterPeek] = peek(currentState);
    if (nextCh === PIPE) {
      currentState = skipWhitespace(matchCh(stateAfterPeek, PIPE));
      continue;
    }

    break;
  }

  if (constructors.length === 0) {
    throw new ParseError(
      withParserState(
        currentState,
        "data definition must declare at least one constructor",
      ),
    );
  }

  return [{
    kind: "data",
    name,
    typeParams,
    constructors,
  }, currentState];
}

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
  let isRecursive = false;

  const [kind, stateAfterKind] = parseDefinitionKeyword(state);
  let name: string;
  let stateAfterName: ParserState;

  if (kind === DATA) {
    const [dataDefinition, finalState] = parseDataDefinition(stateAfterKind);
    return [dataDefinition, skipWhitespace(finalState)];
  }

  if (kind === POLY) {
    const [maybeRec, stateAfterMaybeRec] = parseIdentifier(stateAfterKind);
    if (maybeRec === "rec") {
      isRecursive = true;
      [name, stateAfterName] = parseIdentifier(stateAfterMaybeRec);
    } else {
      name = maybeRec;
      stateAfterName = stateAfterMaybeRec;
    }
  } else {
    [name, stateAfterName] = parseIdentifier(stateAfterKind);
  }

  if (kind === MODULE || kind === IMPORT || kind === EXPORT) {
    switch (kind) {
      case MODULE:
        return [{ kind: MODULE, name }, skipWhitespace(stateAfterName)];
      case IMPORT: {
        // TripLang import syntax: "import <module> <symbol>"
        // Example: "import Prelude zero" imports symbol "zero" from module "Prelude"
        // Parser produces: {name: "Prelude", ref: "zero"}
        const [ref, stateAfterRef] = parseIdentifier(stateAfterName);
        return [{ kind: IMPORT, name, ref }, skipWhitespace(stateAfterRef)];
      }
      case EXPORT:
        // TripLang export syntax: "export <symbol>"
        // Example: "export main" exports the symbol "main" from the current module
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
        ...(isRecursive ? { rec: true } : {}),
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
      throw new ParseError(
        withParserState(currentState, `Unknown definition kind: ${kind}`),
      );
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
