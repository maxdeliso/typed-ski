import { ParseError } from './parseError.js';

export interface ParserState {
  buf: string;
  idx: number;
}

export function createParserState(buf: string): ParserState {
  return { buf, idx: 0 };
}

export function skipWhitespace(state: ParserState): ParserState {
  let idx = state.idx;
  while (idx < state.buf.length && /\s/.test(state.buf[idx])) {
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
    throw new ParseError(`expected '${ch}' but found '${next ?? 'EOF'}'`);
  }
  return consume(newState);
}

export function matchLP(state: ParserState): ParserState {
  return matchCh(state, '(');
}

export function matchRP(state: ParserState): ParserState {
  return matchCh(state, ')');
}


export function parseIdentifier(state: ParserState): [string, ParserState] {
  let id = '';
  let currentState = skipWhitespace(state);
  while (currentState.idx < currentState.buf.length) {
    const ch = currentState.buf[currentState.idx];
    if (!/[a-zA-Z0-9_]/.test(ch)) break;
    id += ch;
    currentState = consume(currentState);
  }
  if (id.length === 0) {
    throw new ParseError('expected an identifier');
  }
  return [id, currentState];
}

export function remaining(state: ParserState): [boolean, ParserState] {
  const newState = skipWhitespace(state);
  return [newState.idx < newState.buf.length, newState];
}

export function parseKeyword(state: ParserState, keywords: string[]): [string, ParserState] {
  const [word, nextState] = parseIdentifier(state);
  if (!keywords.includes(word)) {
    throw new ParseError(`expected keyword, found ${word}`);
  }
  return [word, nextState];
}
