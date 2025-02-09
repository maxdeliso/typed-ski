import { cons } from '../cons.js';
import { ParseError } from './parseError.js';
import { RecursiveDescentBuffer } from './recursiveDescentBuffer.js';

export function parseLambdaChain<T>(
  rdb: RecursiveDescentBuffer,
  parseAtomic: (rdb: RecursiveDescentBuffer) => [string, T]
): [string, T] {
  let resultStr = '';
  let resultTerm: T | undefined = undefined;

  // Continue until we run out of input or hit a token that signals termination.
  while (rdb.remaining() && rdb.peek() !== ')') {
    const [atomLit, atomTerm] = parseAtomic(rdb);
    resultStr += atomLit;
    if (resultTerm === undefined) {
      resultTerm = atomTerm;
    } else {
      resultTerm = cons(resultTerm, atomTerm) as T;
    }
  }

  if (resultTerm === undefined) {
    throw new ParseError('expected a term');
  }

  return [resultStr, resultTerm];
}
