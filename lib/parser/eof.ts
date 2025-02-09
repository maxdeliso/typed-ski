import { RecursiveDescentBuffer } from './recursiveDescentBuffer.js';
import { ParseError } from './parseError.js';

/**
 * Wraps a parser function so that after parsing the input,
 * any extra (unconsumed) input causes an error.
 *
 * @param input the input string to parse
 * @param parser a function that parses from a RecursiveDescentBuffer
 * @returns the result of the parser
 * @throws ParseError if there is leftover input after parsing
 */
export function parseWithEOF<T>(
  input: string,
  parser: (rdb: RecursiveDescentBuffer) => [string, T]
): [string, T] {
  const rdb = new RecursiveDescentBuffer(input);
  const result = parser(rdb);
  if (rdb.remaining()) {
    throw new ParseError(`unexpected extra input: "${rdb.buf.slice(rdb.idx)}"`);
  }
  return result;
}
