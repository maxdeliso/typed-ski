import { Appendable } from './appendable'
import { Expression } from './expression'
import { nt } from './nonterminal'
import { SyntaxExpression } from './syntaxExpression'
import { term, TerminalSymbol } from './terminal'

export class ParseError extends Error { }

/**
 * @param input a string with an SKI expression to parse.
 * @returns an abstract expression corresponding to the parsed input string,
 * should one exist.
 * @throws {ParseError} if the input string is not a well formed expression.
 */
export function parse (input: string): Expression {
  const syn = new Appendable()
  let parenLevel = 0

  for (const ch of input) {
    if (ch === '(') {
      syn.append(nt<SyntaxExpression>(undefined, undefined))
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
      syn.append(term(ch))
    } else {
      throw new ParseError('unrecognized char: ' + ch)
    }
  }

  if (parenLevel !== 0) {
    throw new ParseError('mismatched parens! (late)')
  }

  return syn.flatten()
}
