import { Expression } from './expression'
import { nt } from './nonterminal'
import { SyntaxExpression, append } from './syntaxExpression'
import { term, TerminalSymbol } from './terminal'

export class ParseError extends Error { }

/**
 * @param input a string with an SKI expression to parse.
 * @returns an abstract expression corresponding to the parsed input string,
 * should one exist.
 * @throws {ParseError} if the input string is not a well formed expression.
 */
export function parse (input: string): Expression {
  let syn: SyntaxExpression
  let parenLevel = 0

  for (const ch of input) {
    if (ch === '(') {
      syn = append(syn, nt(undefined, undefined))
      parenLevel++
    } else if (ch === ')') {
      parenLevel--

      if (parenLevel < 0) {
        throw new ParseError('mismatched parens! (early)')
      }
    } else if (
      ch === TerminalSymbol.S ||
      ch === TerminalSymbol.K ||
      ch === TerminalSymbol.I
    ) {
      syn = append(syn, term(ch))
    } else {
      throw new ParseError('unrecognized char: ' + ch)
    }
  }

  if (parenLevel !== 0) {
    throw new ParseError('mismatched parens! (late)')
  }

  return flatten(syn)
}

/**
 * @param exp a syntax expression.
 * @returns an abstract expression.
 * @throws {ParseError} if there are any empty internal nodes in the
 * expression.
 */
export const flatten = (exp: SyntaxExpression): Expression => {
  if (exp === undefined) {
    throw new ParseError('expression undefined (empty)')
  } else if (exp.kind === 'terminal') {
    return exp
  } else if ((exp.lft === undefined) && (exp.rgt !== undefined)) {
    return flatten(exp.rgt)
  } else if ((exp.lft !== undefined) && (exp.rgt === undefined)) {
    return flatten(exp.lft)
  } else if ((exp.lft === undefined) || (exp.rgt === undefined)) {
    throw new ParseError('expression undefined (hole)')
  } else {
    return nt(flatten(exp.lft), flatten(exp.rgt))
  }
}
