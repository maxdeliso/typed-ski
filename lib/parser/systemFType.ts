import { SystemFType, forall } from '../types/systemF.js';
import { arrow, mkTypeVariable } from '../types/types.js';
import { ParseError } from './parseError.js';
import { RecursiveDescentBuffer } from './recursiveDescentBuffer.js';

/**
 * Parses a System F type.
 *
 * Grammar:
 *   Type       ::= "∀" typeVar "." Type
 *                | ArrowType
 *
 *   ArrowType  ::= SimpleType ("→" Type)?
 *
 *   SimpleType ::= type-variable | "(" Type ")"
 */
export function parseSystemFType(
  rdb: RecursiveDescentBuffer
): [string, SystemFType] {
  if (rdb.peek() === '∀') {
    // Parse universal type: ∀X. T
    rdb.consume(); // consume '∀'
    const typeVar = rdb.parseVariable();
    rdb.matchCh('.'); // expect a dot after the type variable
    const [bodyLit, bodyType] = parseSystemFType(rdb);
    return [`∀${typeVar}.${bodyLit}`, forall(typeVar, bodyType)];
  } else {
    // Parse an arrow type.
    const [leftLit, leftType] = parseSimpleSystemFType(rdb);
    if (rdb.peek() === '→') {
      rdb.consume(); // consume the arrow
      const [rightLit, rightType] = parseSystemFType(rdb);
      // Represent the arrow type as a cons cell.
      return [`${leftLit}→${rightLit}`, arrow(leftType, rightType)];
    } else {
      return [leftLit, leftType];
    }
  }
}

/**
   * Parses a simple System F type.
   *
   * SimpleType ::= type-variable | "(" Type ")"
   */
function parseSimpleSystemFType(
  rdb: RecursiveDescentBuffer
): [string, SystemFType] {
  if (rdb.peek() === '(') {
    rdb.matchLP();
    const [innerLit, innerType] = parseSystemFType(rdb);
    if (rdb.peek() !== ')') {
      throw new ParseError('expected \')\' after type expression');
    }
    rdb.matchRP();
    return [`(${innerLit})`, innerType];
  } else {
    // Must be a type variable (a single letter).
    const varLit = rdb.parseVariable();
    return [varLit, mkTypeVariable(varLit)];
  }
}
