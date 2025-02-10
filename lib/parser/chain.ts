import { cons } from '../cons.js';
import { ParseError } from './parseError.js';
import { ParserState, remaining, peek } from './parserState.js';

/**
 * Parses a chain of expressions (applications) by repeatedly
 * consuming atomic terms until either the input is exhausted or a
 * termination token (')') is encountered.
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
  let resultStr = '';
  let resultTerm: T | undefined = undefined;
  let currentState = state;

  for (;;) {
    // Check if any input remains.
    const [hasRemaining, stateAfterRemaining] = remaining(currentState);
    if (!hasRemaining) break;

    // Peek the next non-whitespace character.
    const [peeked, stateAfterPeek] = peek(stateAfterRemaining);
    // Terminate if we encounter a closing parenthesis.
    if (peeked === ')') break;

    // Parse the next atomic term.
    const [atomLit, atomTerm, newState] = parseAtomic(stateAfterPeek);
    resultStr += atomLit;

    // If this is the first term, use it; otherwise, chain via cons.
    if (resultTerm === undefined) {
      resultTerm = atomTerm;
    } else {
      resultTerm = cons(resultTerm, atomTerm) as T;
    }

    // Update the state.
    currentState = newState;
  }

  if (resultTerm === undefined) {
    throw new ParseError('expected a term');
  }

  return [resultStr, resultTerm, currentState];
}
