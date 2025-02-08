import { mkVar } from '../lambda/lambda.ts';
import { TypedLambda, mkTypedAbs } from '../typed/typedLambda.ts';
import { Type, arrow, mkTypeVar } from '../typed/types.ts';
import { ParseError } from './parseError.ts';
import { RecursiveDescentBuffer } from './recursiveDescentBuffer.ts';
import { parseLambdaChain } from './chain.ts';

function parseAtomicTypedLambda(
  rdb: RecursiveDescentBuffer
): [string, TypedLambda] {
  const peeked = rdb.peek();

  if (peeked === 'λ') {
    // Parse a typed lambda abstraction: λx : <type> . <body>
    rdb.matchCh('λ');
    const varLit = rdb.parseVariable();
    rdb.matchCh(':');
    const [typeLit, ty] = parseTypeInternal(rdb);
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

function parseTypeInternal(rdb: RecursiveDescentBuffer): [string, Type] {
  if (rdb.peek() === '(') {
    rdb.matchLP();
    const [leftTypeLit, leftTy] = parseTypeInternal(rdb);

    if ((rdb.peek() === '→')) {
      rdb.consume();
      const [rightTypeLit, rightTy] = parseTypeInternal(rdb);

      if (rdb.peek() !== ')') throw new ParseError('expected a )');
      rdb.matchRP();

      // '(' <ty_1> '→' <ty_2> ')' )
      return [`(${leftTypeLit}→${rightTypeLit})`, arrow(leftTy, rightTy)];
    } else if (rdb.peek() === ')') {
      rdb.consume();

      if (rdb.peek() === '→') {
        rdb.consume();
        const [nextTypeLit, nextTy] = parseTypeInternal(rdb);

        // '(' <ty_1> ')' '→' <ty_2>
        return [`(${leftTypeLit})→${nextTypeLit}`, arrow(leftTy, nextTy)];
      } else {
        // '(' <ty_1> NOT('→', ')')
        return [leftTypeLit, leftTy];
      }
    } else {
      throw new ParseError('expected a → or ) after ( Type');
    }
  } else {
    const varLit = rdb.parseVariable();

    if (rdb.peek() === '→') {
      rdb.consume();
      const [nextTypeLit, t2] = parseTypeInternal(rdb);

      // <var> '→' <ty>
      return [`${varLit}→${nextTypeLit}`, arrow(mkTypeVar(varLit), t2)];
    } else {
      // <var> NOT('→')
      return [varLit, mkTypeVar(varLit)];
    }
  }
}

export function parseType(input: string): [string, Type] {
  const rdb = new RecursiveDescentBuffer(input);
  return parseTypeInternal(rdb);
}

export function parseTypedLambda(input: string): [string, TypedLambda] {
  const rdb = new RecursiveDescentBuffer(input);
  return parseTypedLambdaInternal(rdb);
}

function parseTypedLambdaInternal(
  rdb: RecursiveDescentBuffer
): [string, TypedLambda] {
  return parseLambdaChain<TypedLambda>(rdb, parseAtomicTypedLambda);
}
