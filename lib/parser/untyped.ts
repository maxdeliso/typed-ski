import { UntypedLambda, mkUntypedAbs, mkVar } from '../terms/lambda.js';
import {
  ParserState,
  peek,
  matchCh,
  matchLP,
  matchRP,
  parseVariable,
} from './parserState.js';
import { parseChain } from './chain.js';
import { parseWithEOF } from './eof.js';

/**
 * Parses an untyped lambda term (including applications) by chaining
 * together atomic terms.
 *
 * Returns a triple: [literal, UntypedLambda, updatedState]
 */
function parseUntypedLambdaInternal(
  state: ParserState
): [string, UntypedLambda, ParserState] {
  return parseChain<UntypedLambda>(state, parseAtomicUntypedLambda);
}

/**
 * Parses an atomic untyped lambda term.
 * Atomic terms can be:
 *   - A lambda abstraction: "λx. <body>"
 *   - A parenthesized term: "(" <term> ")"
 *   - A variable: e.g. "x"
 *
 * Returns a triple: [literal, UntypedLambda, updatedState]
 */
export function parseAtomicUntypedLambda(
  state: ParserState
): [string, UntypedLambda, ParserState] {
  const [peeked, s] = peek(state);

  if (peeked === 'λ') {
    // Parse an untyped lambda abstraction: λx. <body>
    const stateAfterLambda = matchCh(s, 'λ'); // consume 'λ'
    const [varLit, stateAfterVar] = parseVariable(stateAfterLambda);
    const stateAfterDot = matchCh(stateAfterVar, '.'); // consume '.'
    const [bodyLit, bodyTerm, stateAfterBody] =
      parseUntypedLambdaInternal(stateAfterDot);
    return [
      `λ${varLit}.${bodyLit}`,
      mkUntypedAbs(varLit, bodyTerm),
      stateAfterBody,
    ];
  } else if (peeked === '(') {
    // Parse a parenthesized term.
    const stateAfterLP = matchLP(s); // consume '('
    const [innerLit, innerTerm, stateAfterInner] =
      parseUntypedLambdaInternal(stateAfterLP);
    const stateAfterRP = matchRP(stateAfterInner); // consume ')'
    return [`(${innerLit})`, innerTerm, stateAfterRP];
  } else {
    // Parse a variable.
    const [varLit, stateAfterVar] = parseVariable(s);
    return [varLit, mkVar(varLit), stateAfterVar];
  }
}

/**
 * Parses an input string into an untyped lambda term.
 *
 * This function delegates to parseWithEOF, which ensures that all input
 * is consumed by the parser.
 */
export function parseLambda(input: string): [string, UntypedLambda] {
  const [lit, term] = parseWithEOF(input, parseUntypedLambdaInternal);
  return [lit, term];
}
