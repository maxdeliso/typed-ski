import { mkVar } from '../terms/lambda.ts';
import { TypedLambda, mkTypedAbs } from '../types/typedLambda.ts';
import { RecursiveDescentBuffer } from './recursiveDescentBuffer.ts';
import { parseLambdaChain } from './chain.ts';
import { parseArrowType } from './type.ts';
import { parseWithEOF } from './eof.ts';

function parseAtomicTypedLambda(
  rdb: RecursiveDescentBuffer
): [string, TypedLambda] {
  const peeked = rdb.peek();

  if (peeked === 'λ') {
    // Parse a typed lambda abstraction: λx : <type> . <body>
    rdb.matchCh('λ');
    const varLit = rdb.parseVariable();
    rdb.matchCh(':');
    const [typeLit, ty] = parseArrowType(rdb);
    rdb.matchCh('.');
    const [bodyLit, bodyTerm] = parseTypedLambdaInternal(rdb);
    return [`λ${varLit}:${typeLit}.${bodyLit}`, mkTypedAbs(varLit, ty, bodyTerm)];
  } else if (peeked === '(') {
    // Parse a parenthesized term.
    rdb.matchLP();
    const [innerLit, innerTerm] = parseTypedLambdaInternal(rdb);
    rdb.matchRP();
    return [`(${innerLit})`, innerTerm];
  } else {
    // Parse a variable.
    const varLit = rdb.parseVariable();
    return [varLit, mkVar(varLit)];
  }
}

function parseTypedLambdaInternal(
  rdb: RecursiveDescentBuffer
): [string, TypedLambda] {
  return parseLambdaChain<TypedLambda>(rdb, parseAtomicTypedLambda);
}

export function parseTypedLambda(input: string): [string, TypedLambda] {
  return parseWithEOF(input, parseTypedLambdaInternal);
}
