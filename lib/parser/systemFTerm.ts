import { cons } from '../cons.js';
import { SystemFTerm, mkSystemFAbs, mkSystemFTAbs, mkSystemFVar, mkSystemFTypeApp } from '../terms/systemF.js';
import { parseWithEOF } from './eof.js';
import { ParseError } from './parseError.js';
import { RecursiveDescentBuffer } from './recursiveDescentBuffer.js';
import { parseSystemFType } from './systemFType.js';

/**
 * Parses an atomic System F term.
 *
 * Atomic terms can be:
 *   - A term abstraction: "λx: T. t"
 *   - A type abstraction: "ΛX. t"
 *   - A parenthesized term: "(" t ")"
 *   - A variable: e.g. "x"
 */
export function parseAtomicSystemFTerm(
  rdb: RecursiveDescentBuffer
): [string, SystemFTerm] {
  const ch = rdb.peek();
  if (ch === 'λ') {
    // Term abstraction: λx: T. t
    rdb.matchCh('λ');
    const varName = rdb.parseVariable();
    rdb.matchCh(':');
    const [typeLit, typeAnnotation] = parseSystemFType(rdb);
    rdb.matchCh('.');
    const [bodyLit, bodyTerm] = parseSystemFTerm(rdb);
    return [
      `λ${varName}:${typeLit}.${bodyLit}`,
      mkSystemFAbs(varName, typeAnnotation, bodyTerm),
    ];
  } else if (ch === 'Λ') {
    // Type abstraction: ΛX. t
    rdb.matchCh('Λ');
    const typeVar = rdb.parseVariable();
    rdb.matchCh('.');
    const [bodyLit, bodyTerm] = parseSystemFTerm(rdb);
    return [
      `Λ${typeVar}.${bodyLit}`,
      mkSystemFTAbs(typeVar, bodyTerm),
    ];
  } else if (ch === '(') {
    // Parenthesized term.
    rdb.matchLP();
    const [innerLit, innerTerm] = parseSystemFTerm(rdb);
    rdb.matchRP();
    return [`(${innerLit})`, innerTerm];
  } else if (ch != null) {
    // Variable.
    const varName = rdb.parseVariable();
    return [varName, mkSystemFVar(varName)];
  } else {
    throw new ParseError('unexpected end-of-input while parsing term');
  }
}

/**
   * Parses a complete System F term.
   *
   * After reading an atomic term, this parser looks for further applications—
   * either term application (by juxtaposition) or type application (using square brackets).
   * Term application is represented as a cons cell.
   */
export function parseSystemFTerm(
  rdb: RecursiveDescentBuffer
): [string, SystemFTerm] {
  let [lit, term] = parseAtomicSystemFTerm(rdb);

  for(;;) {
    const next = rdb.peek();
    if (next === '[') {
      // Type application: t [T]
      rdb.matchCh('[');
      const [typeLit, typeArg] = parseSystemFType(rdb);
      rdb.matchCh(']');
      term = mkSystemFTypeApp(term, typeArg);
      lit = `${lit}[${typeLit}]`;
    } else if (
      next != null &&
        next !== ')' &&
        next !== '.' &&
        next !== ']'
    ) {
      // Term application by juxtaposition.
      const [appLit, appTerm] = parseAtomicSystemFTerm(rdb);
      term = cons(term, appTerm);
      lit = `${lit} ${appLit}`;
    } else {
      break;
    }
  }
  return [lit, term];
}

/**
   * Parses a complete System F expression from an input string.
   *
   * Example:
   *    ΛX. λx: X. x [∀Y. Y→Y]
   */
export function parseSystemF(input: string): [string, SystemFTerm] {
  return parseWithEOF(input, parseSystemFTerm);
}
