import { UntypedLambda, mkUntypedAbs, mkVar } from '../lambda/lambda.ts';
import { RecursiveDescentBuffer } from './recursiveDescentBuffer.ts';
import { parseLambdaChain } from './chain.ts';

export function parseLambda(input: string): [string, UntypedLambda] {
  const rdb = new RecursiveDescentBuffer(input);
  return parseUntypedLambdaInternal(rdb);
}

function parseUntypedLambdaInternal(
  rdb: RecursiveDescentBuffer
): [string, UntypedLambda] {
  return parseLambdaChain<UntypedLambda>(rdb, parseAtomicUntypedLambda);
}

export function parseAtomicUntypedLambda(
  rdb: RecursiveDescentBuffer
): [string, UntypedLambda] {
  const peeked = rdb.peek();

  if (peeked === 'λ') {
    // Parse an untyped lambda abstraction: λx. <body>
    rdb.matchCh('λ');
    const varLit = rdb.parseVariable();
    rdb.matchCh('.');
    const [bodyLit, bodyTerm] = parseUntypedLambdaInternal(rdb);
    return [`λ${varLit}.${bodyLit}`, mkUntypedAbs(varLit, bodyTerm)];
  } else if (peeked === '(') {
    // Parse a parenthesized term.
    rdb.matchLP();
    const [innerLit, innerTerm] = parseUntypedLambdaInternal(rdb);
    rdb.matchRP();
    return [`(${innerLit})`, innerTerm];
  } else {
    // Parse a variable.
    const varLit = rdb.parseVariable();
    return [varLit, mkVar(varLit)];
  }
}
