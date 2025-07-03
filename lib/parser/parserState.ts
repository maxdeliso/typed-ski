import { ParseError } from "./parseError.ts";
import type { DefinitionKind } from "./tripLang.ts";
import {
  COLON,
  DEFINITION_KEYWORDS,
  IDENTIFIER_CHAR_REGEX,
  LEFT_PAREN,
  RIGHT_PAREN,
  WHITESPACE_REGEX,
} from "./tripLang.ts";

export interface ParserState {
  buf: string;
  idx: number;
}

export function createParserState(buf: string): ParserState {
  return { buf, idx: 0 };
}

export function skipWhitespace(state: ParserState): ParserState {
  let idx = state.idx;
  while (idx < state.buf.length && WHITESPACE_REGEX.test(state.buf[idx])) {
    idx++;
  }
  return { buf: state.buf, idx };
}

export function peek(state: ParserState): [string | null, ParserState] {
  const newState = skipWhitespace(state);
  if (newState.idx < newState.buf.length) {
    return [newState.buf[newState.idx], newState];
  }
  return [null, newState];
}

export function consume(state: ParserState): ParserState {
  return { buf: state.buf, idx: state.idx + 1 };
}

export function matchCh(state: ParserState, ch: string): ParserState {
  const [next, newState] = peek(state);
  if (next !== ch) {
    throw new ParseError(`expected '${ch}' but found '${next ?? "EOF"}'`);
  }
  return consume(newState);
}

export function matchLP(state: ParserState): ParserState {
  return matchCh(state, LEFT_PAREN);
}

export function matchRP(state: ParserState): ParserState {
  return matchCh(state, RIGHT_PAREN);
}

export function parseIdentifier(state: ParserState): [string, ParserState] {
  let id = "";
  let currentState = skipWhitespace(state);
  while (currentState.idx < currentState.buf.length) {
    const ch = currentState.buf[currentState.idx];
    if (!IDENTIFIER_CHAR_REGEX.test(ch)) break;
    id += ch;
    currentState = consume(currentState);
  }
  if (id.length === 0) {
    throw new ParseError("expected an identifier");
  }
  return [id, currentState];
}

export function remaining(state: ParserState): [boolean, ParserState] {
  const newState = skipWhitespace(state);
  return [newState.idx < newState.buf.length, newState];
}

export function parseOptionalTypeAnnotation<T>(
  state: ParserState,
  parseType: (state: ParserState) => [string, T, ParserState],
): [T | undefined, ParserState] {
  const [nextCh, _] = peek(state);
  if (nextCh === COLON) {
    const stateAfterColon = matchCh(state, COLON);
    const stateAfterWhitespace = skipWhitespace(stateAfterColon);
    const [, type, stateAfterType] = parseType(stateAfterWhitespace);
    return [type, stateAfterType];
  }
  return [undefined, state];
}

export function parseDefinitionKeyword(
  state: ParserState,
  keywords: readonly string[],
): [DefinitionKind, ParserState] {
  const [word, nextState] = parseIdentifier(state);
  if (!keywords.includes(word)) {
    throw new ParseError(`expected definition keyword, found ${word}`);
  }
  return [word as DefinitionKind, nextState];
}

export function isAtDefinitionKeywordLine(state: ParserState): boolean {
  const maxKeywordLength = Math.max(
    ...DEFINITION_KEYWORDS.map((k) => k.length),
  );
  const sliceLength = maxKeywordLength + 1;
  const nextChars = state.buf.slice(state.idx, state.idx + sliceLength);
  const lines = nextChars.split("\n");
  const firstLine = lines[0].trim();
  return DEFINITION_KEYWORDS.some((keyword: string) =>
    firstLine.startsWith(keyword)
  );
}
