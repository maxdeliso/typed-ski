import { RecursiveDescentBuffer } from './recursiveDescentBuffer.js';
import { ParseError } from './parseError.js';
import { BaseType, arrow, mkTypeVariable } from '../types/types.js';
import { parseWithEOF } from './eof.js';

/**
 * Parses a "simple" type.
 * Simple types are either a variable or a parenthesized type.
 */
export function parseSimpleType(rdb: RecursiveDescentBuffer): [string, BaseType] {
  if (rdb.peek() === '(') {
    rdb.matchLP();
    // Recursively parse a full type inside parentheses.
    const [innerLit, innerType] = parseArrowType(rdb);
    if (rdb.peek() !== ')') {
      throw new ParseError('expected \')\' after type expression');
    }
    rdb.matchRP();
    return [`(${innerLit})`, innerType];
  } else {
    // A variable.
    const varLit = rdb.parseVariable();
    return [varLit, mkTypeVariable(varLit)];
  }
}

/**
 * Parses an arrow type.
 * This function implements right associativity: it checks for an arrow following a simple type,
 * and if present, recursively parses the right–hand side.
 */
export function parseArrowType(rdb: RecursiveDescentBuffer): [string, BaseType] {
  const [leftLit, leftType] = parseSimpleType(rdb);

  // If an arrow follows, then parse the rest as an ArrowType.
  if (rdb.peek() === '→') {
    rdb.consume();
    const [rightLit, rightType] = parseArrowType(rdb);
    return [`${leftLit}→${rightLit}`, arrow(leftType, rightType)];
  } else {
    return [leftLit, leftType];
  }
}

export function parseType(input: string): [string, BaseType] {
  return parseWithEOF(input, parseArrowType);
}
