import { mkUntypedAbs, mkVar, type UntypedLambda } from "../terms/lambda.ts";
import {
  matchCh,
  matchLP,
  matchRP,
  parseIdentifier,
  type ParserState,
  peek,
} from "./parserState.ts";
import { parseChain } from "./chain.ts";
import { parseWithEOF } from "./eof.ts";

/**
 * Parses an untyped lambda term (including applications) by chaining
 * together atomic terms.
 *
 * Returns a triple: [literal, UntypedLambda, updatedState]
 */
export function parseUntypedLambdaInternal(
  state: ParserState,
): [string, UntypedLambda, ParserState] {
  return parseChain<UntypedLambda>(state, parseAtomicUntypedLambda);
}

/**
 * Parses an atomic untyped lambda term, tracking the literal substring precisely.
 */
export function parseAtomicUntypedLambda(
  state: ParserState,
): [string, UntypedLambda, ParserState] {
  const [peeked, s] = peek(state);

  if (peeked === "λ") {
    let currentState = matchCh(s, "λ");
    const [varLit, stateAfterVar] = parseIdentifier(currentState);
    currentState = matchCh(stateAfterVar, ".");
    const [, bodyTerm, stateAfterBody] = parseUntypedLambdaInternal(
      currentState,
    );
    const literal = s.buf.slice(s.idx, stateAfterBody.idx);
    return [
      literal,
      mkUntypedAbs(varLit, bodyTerm),
      stateAfterBody,
    ];
  } else if (peeked === "(") {
    let currentState = matchLP(s);
    const [, innerTerm, stateAfterInner] = parseUntypedLambdaInternal(
      currentState,
    );
    currentState = matchRP(stateAfterInner);
    const fullLiteral = s.buf.slice(s.idx, currentState.idx);
    return [fullLiteral, innerTerm, currentState];
  } else {
    const [varLit, stateAfterVar] = parseIdentifier(s);
    const fullLiteral = s.buf.slice(s.idx, stateAfterVar.idx);
    return [fullLiteral, mkVar(varLit), stateAfterVar];
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
