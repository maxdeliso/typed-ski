import { mkVar } from '../terms/lambda.js';
import { TypedLambda, mkTypedAbs } from '../types/typedLambda.js';
import { ParserState, peek, matchCh, matchLP, matchRP, parseIdentifier } from './parserState.js';
import { parseChain } from './chain.js';
import { parseArrowType } from './type.js';
import { parseWithEOF } from './eof.js';
import { ParseError } from './parseError.js';

/**
 * Parses an atomic typed lambda term.
 * Atomic terms can be:
 *   - A typed lambda abstraction: "λx : <type> . <body>"
 *   - A parenthesized term: "(" <term> ")"
 *   - A variable: e.g. "x"
 *
 * Returns a triple: [literal, TypedLambda, updated ParserState]
 */
export function parseAtomicTypedLambda(
  state: ParserState
): [string, TypedLambda, ParserState] {
  const [peeked, s] = peek(state);

  if (peeked === 'λ') {
    // Parse a typed lambda abstraction: λx : <type> . <body>
    const stateAfterLambda = matchCh(s, 'λ');
    const [next] = peek(stateAfterLambda);
    if (next === ':') {
      throw new ParseError('expected an identifier');
    }
    const [varLit, stateAfterVar] = parseIdentifier(stateAfterLambda);
    const stateAfterColon = matchCh(stateAfterVar, ':');
    const [typeLit, ty, stateAfterType] = parseArrowType(stateAfterColon);
    const stateAfterDot = matchCh(stateAfterType, '.');
    const [bodyLit, bodyTerm, stateAfterBody] = parseTypedLambdaInternal(stateAfterDot);
    return [
      `λ${varLit}:${typeLit}.${bodyLit}`,
      mkTypedAbs(varLit, ty, bodyTerm),
      stateAfterBody
    ];
  } else if (peeked === '(') {
    // Parse a parenthesized term.
    const stateAfterLP = matchLP(s);
    const [innerLit, innerTerm, stateAfterInner] = parseTypedLambdaInternal(stateAfterLP);
    const stateAfterRP = matchRP(stateAfterInner);
    return [`(${innerLit})`, innerTerm, stateAfterRP];
  } else {
    const [varLit, stateAfterVar] = parseIdentifier(s);
    return [varLit, mkVar(varLit), stateAfterVar];
  }
}

/**
 * Parses a typed lambda term (handling applications by chaining together atomic terms).
 *
 * Returns a triple: [literal, TypedLambda, updated ParserState]
 */
export function parseTypedLambdaInternal(
  state: ParserState
): [string, TypedLambda, ParserState] {
  return parseChain<TypedLambda>(state, parseAtomicTypedLambda);
}

/**
 * Parses an input string into a typed lambda term.
 * Uses parseWithEOF to ensure the entire input is consumed.
 *
 * Returns a pair: [literal, TypedLambda]
 */
export function parseTypedLambda(input: string): [string, TypedLambda] {
  const [lit, term] = parseWithEOF(input, parseTypedLambdaInternal);
  return [lit, term];
}

export { parseArrowType };
