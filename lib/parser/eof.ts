/**
 * End-of-file parsing utilities.
 *
 * This module provides utilities for ensuring that parsers consume
 * all input by checking for leftover characters after parsing.
 *
 * @module
 */
import {
  createParserState,
  type ParserState,
  remaining,
  withParserState,
} from "./parserState.ts";
import { ParseError } from "./parseError.ts";

/**
 * Wraps a parser function so that after parsing the input,
 * any extra (unconsumed) input causes an error.
 *
 * @param input the input string to parse
 * @param parser a function that parses from an RDB and returns a tuple:
 *               [literal, result, updatedState]
 * @returns the result of the parser along with its literal and final state
 * @throws ParseError if there is leftover input after parsing
 */
export function parseWithEOF<T>(
  input: string,
  parser: (rdb: ParserState) => [string, T, ParserState],
): [string, T, ParserState] {
  const initialState = createParserState(input);
  const [lit, result, updatedState] = parser(initialState);
  const [hasRemaining, finalState] = remaining(updatedState);
  if (hasRemaining) {
    throw new ParseError(
      withParserState(
        finalState,
        `unexpected extra input: "${finalState.buf.slice(finalState.idx)}"`,
      ),
    );
  }
  return [lit, result, finalState];
}
