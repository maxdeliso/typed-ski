import { ParseError } from './parseError.js';

/**
 * An immutable parser state.
 */
export interface ParserState {
  buf: string;
  idx: number;
}

/**
 * Creates a new parser state from the given string.
 */
export function createParserState(buf: string): ParserState {
  return { buf, idx: 0 };
}

/**
 * Advances the index past any whitespace characters.
 */
function skipWhitespace(rdb: ParserState): ParserState {
  let idx = rdb.idx;
  while (idx < rdb.buf.length && /\s/.test(rdb.buf[idx])) {
    idx++;
  }
  return { buf: rdb.buf, idx };
}

/**
 * Returns the next non‐whitespace character (or null if at end‐of-buffer),
 * along with the updated state.
 */
export function peek(rdb: ParserState): [string | null, ParserState] {
  const state = skipWhitespace(rdb);
  if (state.idx < state.buf.length) {
    return [state.buf[state.idx], state];
  }
  return [null, state];
}

/**
 * Consumes one character and returns the updated state.
 */
export function consume(rdb: ParserState): ParserState {
  return { buf: rdb.buf, idx: rdb.idx + 1 };
}

/**
 * Matches the given character (after skipping whitespace). Throws a ParseError
 * if the next non‐whitespace character is not the expected one.
 */
export function matchCh(rdb: ParserState, ch: string): ParserState {
  const [next, state] = peek(rdb);
  if (next !== ch) {
    throw new ParseError(`expected ${ch} but found ${next ?? 'null'}`);
  }
  return consume(state);
}

/**
 * Matches a left parenthesis.
 */
export function matchLP(rdb: ParserState): ParserState {
  return matchCh(rdb, '(');
}

/**
 * Matches a right parenthesis.
 */
export function matchRP(rdb: ParserState): ParserState {
  return matchCh(rdb, ')');
}

/**
 * Checks whether there is any non‐whitespace character left, returning both the
 * boolean result and the updated state.
 */
export function remaining(rdb: ParserState): [boolean, ParserState] {
  const state = skipWhitespace(rdb);
  return [state.idx < state.buf.length, state];
}

/**
 * Parses a variable from the input. The variable is expected to be a letter.
 */
export function parseVariable(rdb: ParserState): [string, ParserState] {
  const [next, state] = peek(rdb);
  if (next === null) {
    throw new ParseError('failed to parse variable: no next character');
  }
  if (!/[a-zA-Z]/.test(next)) {
    throw new ParseError(`failed to parse variable: ${next} did not match`);
  }
  return [next, consume(state)];
}
