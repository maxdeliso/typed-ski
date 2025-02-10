import { cons } from '../cons.js';
import {
  SystemFTerm,
  mkSystemFAbs,
  mkSystemFTAbs,
  mkSystemFVar,
  mkSystemFTypeApp,
} from '../terms/systemF.js';
import { parseWithEOF } from './eof.js';
import { ParseError } from './parseError.js';
import { matchCh, matchLP, matchRP } from './parserState.js';
import { ParserState, parseVariable, peek } from './parserState.js';

import { parseSystemFType } from './systemFType.js';

/**
 * Parses an atomic System F term.
 *
 * Atomic terms can be:
 *   - A term abstraction: "λx: T. t"
 *   - A type abstraction: "ΛX. t"
 *   - A parenthesized term: "(" t ")"
 *   - A variable: e.g. "x"
 *
 * Returns a triple: [literal, SystemFTerm, updated state]
 */
export function parseAtomicSystemFTerm(
  rdb: ParserState
): [string, SystemFTerm, ParserState] {
  const [ch, state] = peek(rdb);
  if (ch === 'λ') {
    // Term abstraction: λx: T. t
    const stateAfterLambda = matchCh(state, 'λ');
    const [varName, stateAfterVar] = parseVariable(stateAfterLambda);
    const stateAfterColon = matchCh(stateAfterVar, ':');
    const [typeLit, typeAnnotation, stateAfterType] = parseSystemFType(
      stateAfterColon
    );
    const stateAfterDot = matchCh(stateAfterType, '.');
    const [bodyLit, bodyTerm, stateAfterBody] = parseSystemFTerm(
      stateAfterDot
    );
    return [
      `λ${varName}:${typeLit}.${bodyLit}`,
      mkSystemFAbs(varName, typeAnnotation, bodyTerm),
      stateAfterBody,
    ];
  } else if (ch === 'Λ') {
    // Type abstraction: ΛX. t
    const stateAfterLambdaT = matchCh(state, 'Λ');
    const [typeVar, stateAfterVar] = parseVariable(stateAfterLambdaT);
    const stateAfterDot = matchCh(stateAfterVar, '.');
    const [bodyLit, bodyTerm, stateAfterBody] = parseSystemFTerm(
      stateAfterDot
    );
    return [
      `Λ${typeVar}.${bodyLit}`,
      mkSystemFTAbs(typeVar, bodyTerm),
      stateAfterBody,
    ];
  } else if (ch === '(') {
    // Parenthesized term.
    const stateAfterLP = matchLP(state);
    const [innerLit, innerTerm, stateAfterTerm] = parseSystemFTerm(
      stateAfterLP
    );
    const stateAfterRP = matchRP(stateAfterTerm);
    return [`(${innerLit})`, innerTerm, stateAfterRP];
  } else if (ch != null) {
    // Variable.
    const [varName, stateAfterVar] = parseVariable(state);
    return [varName, mkSystemFVar(varName), stateAfterVar];
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
 *
 * Returns a triple: [literal, SystemFTerm, updated state]
 */
export function parseSystemFTerm(
  rdb: ParserState
): [string, SystemFTerm, ParserState] {
  let [lit, term, state] = parseAtomicSystemFTerm(rdb);

  for (;;) {
    const [next, stateAfterPeek] = peek(state);
    if (next === '[') {
      // Type application: t [T]
      const stateAfterOpenBracket = matchCh(stateAfterPeek, '[');
      const [typeLit, typeArg, stateAfterType] = parseSystemFType(
        stateAfterOpenBracket
      );
      const stateAfterCloseBracket = matchCh(stateAfterType, ']');
      term = mkSystemFTypeApp(term, typeArg);
      lit = `${lit}[${typeLit}]`;
      state = stateAfterCloseBracket;
    } else if (
      next != null &&
      next !== ')' &&
      next !== '.' &&
      next !== ']'
    ) {
      // Term application by juxtaposition.
      const [appLit, appTerm, stateAfterAtomic] = parseAtomicSystemFTerm(
        stateAfterPeek
      );
      term = cons(term, appTerm);
      lit = `${lit} ${appLit}`;
      state = stateAfterAtomic;
    } else {
      break;
    }
  }
  return [lit, term, state];
}

/**
 * Parses a complete System F expression from an input string.
 *
 * Example:
 *    ΛX. λx: X. x [∀Y. Y→Y]
 *
 * Returns a pair: [literal, SystemFTerm]
 */
export function parseSystemF(input: string): [string, SystemFTerm] {
  const [lit, term] = parseWithEOF(input, parseSystemFTerm);
  return [lit, term];
}
