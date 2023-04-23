import { NonTerminal } from './nonterminal'
import { Terminal } from './terminal'

/**
 * A variation on the expression type that allows undefined values.
 * This version is used to build up a syntax expression during parsing,
 * which is then converted into an abstract expression after the parse,
 * while verifying that no undefined values, or 'holes', remain.
 */
export type SyntaxExpression
  = Terminal
  | NonTerminal<SyntaxExpression>
  | undefined;
