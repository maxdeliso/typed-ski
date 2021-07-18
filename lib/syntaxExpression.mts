import { NonTerminal, nt } from './nonterminal.mjs'
import { Terminal } from './terminal.mjs'

/**
 * A variation on the expression type, that allows undefined values.
 * This version is used to build up a syntax expression during parsing,
 * which is then converted into an abstract expression after the parse,
 * while verifying that no undefined values, or 'holes', remain.
 */
export type SyntaxExpression
  = Terminal
  | NonTerminal<SyntaxExpression>
  | undefined;

/**
 * @param exp a syntax expression.
 * @returns true if there is a hole, false otherwise.
 */
export const hasHole = (exp: SyntaxExpression): boolean =>
  exp === undefined ||
    (exp.kind === 'non-terminal' && (hasHole(exp.lft) || hasHole(exp.rgt)))

/**
 * @param lft a syntax expression.
 * @param rgt a second syntax expression.
 * @returns the two expressions, appended together.
 */
export const append = (lft: SyntaxExpression, rgt: SyntaxExpression):
  SyntaxExpression => {
  if (lft === undefined) {
    return rgt
  } else if (rgt === undefined) {
    return lft
  } else if (lft.kind === 'terminal') {
    return nt(lft, rgt)
  } else if (hasHole(lft.lft)) {
    return nt(append(lft.lft, rgt), lft.rgt)
  } else if (hasHole(lft.rgt)) {
    return nt(lft.lft, append(lft.rgt, rgt))
  } else {
    return nt(lft, rgt)
  }
}
