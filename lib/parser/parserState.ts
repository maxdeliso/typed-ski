/**
 * Parser state management and utilities.
 *
 * This module provides the core parser state interface and utility functions
 * for character consumption, token matching, and identifier parsing.
 *
 * @module
 */
import { ParseError } from "./parseError.ts";
import { isNatLiteralIdentifier } from "../consts/natNames.ts";
import type { DefinitionKind } from "./definition.ts";
import { DEFINITION_KEYWORDS } from "./definition.ts";
import {
  ARROW,
  ASCII_MAX,
  BLOCK_COMMENT_CLOSE,
  BLOCK_COMMENT_OPEN,
  COLON,
  DIGIT_REGEX,
  FAT_ARROW,
  IDENTIFIER_CHAR_REGEX,
  LEFT_PAREN,
  LINE_COMMENT,
  PURELY_NUMERIC_REGEX,
  RIGHT_PAREN,
  WHITESPACE_REGEX,
} from "./consts.ts";

export interface ParserState {
  buf: string;
  idx: number;
}

export const isDigit = (ch: string | null): ch is string => {
  return ch !== null && DIGIT_REGEX.test(ch);
};

export function createParserState(buf: string): ParserState {
  for (let i = 0; i < buf.length; i++) {
    const code = buf.charCodeAt(i);
    if (code > ASCII_MAX) {
      throw new ParseError(
        withParserState(
          { buf, idx: i },
          `non-ASCII byte 0x${code.toString(16).toUpperCase()} at offset ${i}`,
        ),
      );
    }
  }
  return { buf, idx: 0 };
}

/**
 * Consumes a Haskell-style block comment and returns the index just past its
 * matching close delimiter. `start` must point at the opening `{-`.
 *
 * Block comments nest, so `{- a {- b -} c -}` is a single comment. An
 * unterminated comment is a parse error.
 */
function skipBlockComment(buf: string, start: number): number {
  let idx = start + BLOCK_COMMENT_OPEN.length;
  let depth = 1;
  while (idx < buf.length && depth > 0) {
    if (buf.startsWith(BLOCK_COMMENT_OPEN, idx)) {
      depth++;
      idx += BLOCK_COMMENT_OPEN.length;
    } else if (buf.startsWith(BLOCK_COMMENT_CLOSE, idx)) {
      depth--;
      idx += BLOCK_COMMENT_CLOSE.length;
    } else {
      idx++;
    }
  }
  if (depth > 0) {
    throw new ParseError(
      withParserState(
        { buf, idx: start },
        "unterminated block comment (expected '-}')",
      ),
    );
  }
  return idx;
}

/**
 * Advances past insignificant input: whitespace and Haskell-style comments.
 *
 * Two comment forms are recognized:
 *   - Line comments: `--` through the end of the line.
 *   - Block comments: `{- ... -}`, which nest.
 *
 * Every token-level helper (`peek`, `matchCh`, `parseIdentifier`, `remaining`,
 * ...) funnels through here, so comments are accepted anywhere whitespace is
 * without any further changes elsewhere in the parser. String and character
 * literals are read raw by their own parsers and never re-enter this function,
 * so `--`/`{-` inside a literal stays literal.
 *
 * There is no ambiguity with existing tokens: TripLang has no `-` operator, so
 * `--` always starts a line comment (the arrows `->`/`=>` never contain `--`),
 * and a `{` that opens a list/pair/match block is always followed by
 * whitespace or a type/`|`, never by `-`, so `{-` always starts a comment.
 *
 * @throws ParseError on an unterminated block comment.
 */
export function skipWhitespace(state: ParserState): ParserState {
  const { buf } = state;
  let idx = state.idx;
  for (;;) {
    while (idx < buf.length && WHITESPACE_REGEX.test(buf[idx]!)) {
      idx++;
    }
    if (buf.startsWith(LINE_COMMENT, idx)) {
      idx += LINE_COMMENT.length;
      while (idx < buf.length && buf[idx] !== "\n") {
        idx++;
      }
      continue;
    }
    if (buf.startsWith(BLOCK_COMMENT_OPEN, idx)) {
      idx = skipBlockComment(buf, idx);
      continue;
    }
    break;
  }
  return { buf, idx };
}

export function peek(state: ParserState): [string | null, ParserState] {
  const newState = skipWhitespace(state);
  if (newState.idx < newState.buf.length) {
    return [newState.buf[newState.idx]!, newState];
  }
  return [null, newState];
}

export function consume(state: ParserState): ParserState {
  return { buf: state.buf, idx: state.idx + 1 };
}

function formatParserState(state: ParserState): string {
  const contextLength = 20;
  const start = Math.max(0, state.idx - contextLength);
  const end = Math.min(state.buf.length, state.idx + contextLength + 1);
  const snippet = state.buf.slice(start, end);
  const relativePos = state.idx - start;
  const caret = " ".repeat(relativePos) + "^";
  const lines = state.buf.slice(0, state.idx).split("\n");
  const lineNum = lines.length;
  const colNum = lines[lines.length - 1]!.length + 1;
  return `at position ${state.idx} (line ${lineNum}, column ${colNum}):\n${snippet}\n${caret}`;
}

export function withParserState(state: ParserState, msg: string): string {
  return `${msg}\n${formatParserState(state)}`;
}

export function matchCh(state: ParserState, ch: string): ParserState {
  const [next, newState] = peek(state);
  if (next !== ch) {
    throw new ParseError(
      withParserState(
        newState,
        `expected '${ch}' but found '${next ?? "EOF"}'`,
      ),
    );
  }
  return consume(newState);
}

export function matchLP(state: ParserState): ParserState {
  return matchCh(state, LEFT_PAREN);
}

export function matchRP(state: ParserState): ParserState {
  return matchCh(state, RIGHT_PAREN);
}

export function peekArrow(state: ParserState): [boolean, ParserState] {
  const newState = skipWhitespace(state);
  return [
    newState.buf.slice(newState.idx, newState.idx + ARROW.length) === ARROW,
    newState,
  ];
}

export function matchArrow(state: ParserState): ParserState {
  const [isArrow, newState] = peekArrow(state);
  if (!isArrow) {
    const next =
      newState.idx < newState.buf.length ? newState.buf[newState.idx] : "EOF";
    throw new ParseError(
      withParserState(newState, `expected '->' but found '${next}'`),
    );
  }
  return { buf: newState.buf, idx: newState.idx + ARROW.length };
}

export function peekFatArrow(state: ParserState): [boolean, ParserState] {
  const newState = skipWhitespace(state);
  return [
    newState.buf.slice(newState.idx, newState.idx + FAT_ARROW.length) ===
      FAT_ARROW,
    newState,
  ];
}

export function matchFatArrow(state: ParserState): ParserState {
  const [isArrow, newState] = peekFatArrow(state);
  if (!isArrow) {
    const next =
      newState.idx < newState.buf.length ? newState.buf[newState.idx] : "EOF";
    throw new ParseError(
      withParserState(newState, `expected '=>' but found '${next}'`),
    );
  }
  return { buf: newState.buf, idx: newState.idx + FAT_ARROW.length };
}

export function peekBindArrow(state: ParserState): [boolean, ParserState] {
  const newState = skipWhitespace(state);
  return [
    newState.buf.slice(newState.idx, newState.idx + 2) === "<-",
    newState,
  ];
}

export function matchBindArrow(state: ParserState): ParserState {
  const [isArrow, newState] = peekBindArrow(state);
  if (!isArrow) {
    const next =
      newState.idx < newState.buf.length ? newState.buf[newState.idx] : "EOF";
    throw new ParseError(
      withParserState(newState, `expected '<-' but found '${next}'`),
    );
  }
  return { buf: newState.buf, idx: newState.idx + 2 };
}

export function parseIdentifier(state: ParserState): [string, ParserState] {
  let id = "";
  let currentState = skipWhitespace(state);
  while (currentState.idx < currentState.buf.length) {
    const ch = currentState.buf[currentState.idx]!;
    if (!IDENTIFIER_CHAR_REGEX.test(ch)) break;
    id += ch;
    currentState = consume(currentState);
  }
  if (id.length === 0) {
    throw new ParseError(
      withParserState(currentState, "expected an identifier"),
    );
  }
  // Reject purely numeric identifiers (e.g., "123") to avoid ambiguity with numeric literals
  if (PURELY_NUMERIC_REGEX.test(id)) {
    throw new ParseError(
      withParserState(
        currentState,
        `'${id}' is not a valid identifier (purely numeric strings are reserved for numeric literals)`,
      ),
    );
  }
  if (isNatLiteralIdentifier(id)) {
    throw new ParseError(
      withParserState(currentState, `'${id}' is reserved for numeric literals`),
    );
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
): [DefinitionKind, ParserState] {
  const [word, nextState] = parseIdentifier(state);
  if (!DEFINITION_KEYWORDS.includes(word as DefinitionKind)) {
    throw new ParseError(
      withParserState(nextState, `expected definition keyword, found ${word}`),
    );
  }
  return [word as DefinitionKind, nextState];
}

export function parseNumericLiteral(
  state: ParserState,
): [string, bigint, ParserState] {
  let literal = "";
  let currentState = skipWhitespace(state);

  while (currentState.idx < currentState.buf.length) {
    const ch = currentState.buf[currentState.idx]!;
    if (!DIGIT_REGEX.test(ch)) break;
    literal += ch;
    currentState = consume(currentState);
  }

  if (literal.length === 0) {
    throw new ParseError(
      withParserState(currentState, "expected numeric literal"),
    );
  }

  return [literal, BigInt(literal), currentState];
}

export function isAtDefinitionKeywordLine(state: ParserState): boolean {
  const maxKeywordLength = Math.max(
    ...DEFINITION_KEYWORDS.map((k) => k.length),
  );
  const sliceLength = maxKeywordLength + 1;
  const nextChars = state.buf.slice(state.idx, state.idx + sliceLength);
  const lines = nextChars.split("\n");
  const firstLine = lines[0]!.trim();
  return DEFINITION_KEYWORDS.some((keyword: string) => {
    if (firstLine === keyword) {
      return true;
    }
    const nextChar = firstLine[keyword.length];
    return firstLine.startsWith(keyword) && /\s/.test(nextChar ?? "");
  });
}

export function peekThunkOpen(state: ParserState): [boolean, ParserState] {
  const newState = skipWhitespace(state);
  return [
    newState.buf.slice(newState.idx, newState.idx + 2) === "[*",
    newState,
  ];
}

export function matchThunkOpen(state: ParserState): ParserState {
  const [isOpen, newState] = peekThunkOpen(state);
  if (!isOpen) {
    throw new ParseError(withParserState(newState, "expected '[*'"));
  }
  return { buf: newState.buf, idx: newState.idx + 2 };
}

export function peekThunkClose(state: ParserState): [boolean, ParserState] {
  const newState = skipWhitespace(state);
  return [
    newState.buf.slice(newState.idx, newState.idx + 2) === "*]",
    newState,
  ];
}

export function matchThunkClose(state: ParserState): ParserState {
  const [isClose, newState] = peekThunkClose(state);
  if (!isClose) {
    throw new ParseError(withParserState(newState, "expected '*]'"));
  }
  return { buf: newState.buf, idx: newState.idx + 2 };
}

export function peekForce(state: ParserState): [boolean, ParserState] {
  const newState = skipWhitespace(state);
  return [
    newState.buf.slice(newState.idx, newState.idx + 2) === "*!",
    newState,
  ];
}

export function matchForce(state: ParserState): ParserState {
  const [isForce, newState] = peekForce(state);
  if (!isForce) {
    throw new ParseError(withParserState(newState, "expected '*!'"));
  }
  return { buf: newState.buf, idx: newState.idx + 2 };
}
