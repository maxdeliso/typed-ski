import { cons } from "../cons.ts";
import { ParseError } from "./parseError.ts";
import {
  isAtDefinitionKeywordLine,
  type ParserState,
  peek,
  remaining,
  skipWhitespace,
} from "./parserState.ts";

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
  parseAtomic: (state: ParserState) => [string, T, ParserState],
): [string, T, ParserState] {
  const literals: string[] = [];
  let resultTerm: T | undefined = undefined;
  let currentState = skipWhitespace(state);

  for (;;) {
    const [hasRemaining] = remaining(currentState);
    if (!hasRemaining) break;
    const [peeked] = peek(currentState);

    if (peeked === ")") break;

    if (isAtDefinitionKeywordLine(currentState)) {
      break;
    }

    const [atomLit, atomTerm, newState] = parseAtomic(currentState);
    literals.push(atomLit);

    if (resultTerm === undefined) {
      resultTerm = atomTerm;
    } else {
      resultTerm = cons(resultTerm, atomTerm) as T;
    }

    currentState = skipWhitespace(newState);
  }

  if (resultTerm === undefined) {
    throw new ParseError("expected a term");
  }

  return [literals.join(" "), resultTerm, currentState];
}
