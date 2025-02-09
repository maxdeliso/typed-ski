import { SKIExpression } from '../ski/expression.js';
import { RecursiveDescentBuffer } from './recursiveDescentBuffer.js';
import { ParseError } from './parseError.js';
import { parseWithEOF } from './eof.js';
import { cons } from '../cons.js';
import { SKITerminalSymbol, term } from '../ski/terminal.js';

/**
 * Parses a chain of SKI atomic terms (term { term }).
 * For example, the input "SII" will be parsed as:
 *    mkApp(mkApp(S, I), I)
 */
function parseSKIChain(rdb: RecursiveDescentBuffer): [string, SKIExpression] {
  let [lit, expr] = parseAtomicSKI(rdb);
  // While the next token is one that can begin an atomic SKI term,
  // continue parsing and left‐associatively combine.
  for (;;) {
    const next = rdb.peek();
    if (
      next === null ||
      (next !== '(' && !['S', 'K', 'I'].includes(next.toUpperCase()))
    ) {
      break;
    }
    const [nextLit, nextExpr] = parseAtomicSKI(rdb);
    lit = `${lit} ${nextLit}`;
    expr = cons(expr, nextExpr);
  }
  return [lit, expr];
}

/**
 * Parses an atomic SKI term.
 * This is either one of the terminals S, K, I or a parenthesized SKI expression.
 */
export function parseAtomicSKI(rdb: RecursiveDescentBuffer): [string, SKIExpression] {
  const peeked = rdb.peek();
  if (peeked === '(') {
    // Parse a parenthesized expression.
    rdb.matchLP();
    // Inside parentheses we parse a whole chain.
    const [innerLit, innerExpr] = parseSKIChain(rdb);
    rdb.matchRP();
    return [`(${innerLit})`, innerExpr];
  } else if (peeked?.toUpperCase() === 'S' || peeked?.toUpperCase() === 'K' || peeked?.toUpperCase() === 'I') {
    const token = peeked.toUpperCase();
    rdb.consume();
    return [peeked, term(token as SKITerminalSymbol)];
  } else {
    const unexpected = peeked === null ? 'EOF' : `"${peeked}"`;
    throw new ParseError(`unexpected token ${unexpected} when expecting an SKI term`);
  }
}

/**
 * Parses a full SKI expression.
 * (This is just a wrapper around parseSKIChain, which implements the
 * left-associative application.)
 */
export function parseSKIInternal(rdb: RecursiveDescentBuffer): [string, SKIExpression] {
  return parseSKIChain(rdb);
}

export function parseSKI(input: string): SKIExpression {
  const result = parseWithEOF(input, parseSKIInternal);
  return result[1];
}
