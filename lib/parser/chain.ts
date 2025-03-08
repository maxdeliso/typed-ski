import { cons } from '../cons.js';
import { ParseError } from './parseError.js';
import { ParserState, remaining, peek, skipWhitespace } from './parserState.js';

/**
 * Parses a chain of expressions (applications) by repeatedly
 * consuming atomic terms until either the input is exhausted,
 * a termination token (')') is encountered, or a newline is found
 * that's not part of whitespace within a term.
 *
 * @param state the current parser state.
 * @param parseAtomic a function that parses an atomic term from the state,
 *   returning a triple: [literal, term, updatedState].
 * @returns a triple: [concatenated literal, chained term, updated parser state].
 * @throws ParseError if no term is parsed.
 */
export function parseChain<T>(
  state: ParserState,
  parseAtomic: (state: ParserState) => [string, T, ParserState]
): [string, T, ParserState] {
  const literals: string[] = [];
  let resultTerm: T | undefined = undefined;
  let currentState = skipWhitespace(state);

  for (;;) {
    // Check if any input remains.
    const [hasRemaining] = remaining(currentState);
    if (!hasRemaining) break;

    // Peek the next non-whitespace character.
    const [peeked] = peek(currentState);

    if (peeked === ')') break;

    // Check if we're at a newline that's not part of whitespace within a term
    if (peeked === '\n' || peeked === '\r') {
      // If we're at a newline, stop parsing this term
      break;
    }

    const nextChars = currentState.buf.slice(currentState.idx, currentState.idx + 5);

    // Terminate if we encounter a keyword
    if (
      nextChars === 'typed' ||
      nextChars === 'type ' ||
      nextChars === 'poly ' ||
      nextChars === 'untyp' ||
      nextChars === 'combi') {
      break;
    }

    const [atomLit, atomTerm, newState] = parseAtomic(currentState);
    literals.push(atomLit);

    // If this is the first term, use it; otherwise, chain via cons.
    if (resultTerm === undefined) {
      resultTerm = atomTerm;
    } else {
      resultTerm = cons(resultTerm, atomTerm) as T;
    }

    // Update the state and skip any whitespace.
    currentState = skipWhitespace(newState);
  }

  if (resultTerm === undefined) {
    throw new ParseError('expected a term');
  }

  return [literals.join(' '), resultTerm, currentState];
}
