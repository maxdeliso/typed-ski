import { NonTerminal } from './nonterminal'

/**
 * This is a single term variable with a name.
 *
 * For instance, in the expression "λx:a.y", this is just "y".
 */
export type LambdaVar = {
  kind: 'lambda-var',
  name: string
}

export const mkVar = (name: string): LambdaVar => ({
  kind: 'lambda-var',
  name
})

// λx.<body>, where x is a name
type UntypedLambdaAbs = {
  kind: 'lambda-abs',
  name: string,
  // eslint-disable-next-line no-use-before-define
  body: UntypedLambda
}

export const mkUntypedAbs =
  // eslint-disable-next-line no-use-before-define
  (name: string, body: UntypedLambda): UntypedLambda => ({
    kind: 'lambda-abs',
    name,
    body
  })

/**
 * The legal terms of the untyped lambda calculus.
 * e ::= x | λx.e | e e, where x is a variable name, and e is a valid expr
 */
export type UntypedLambda
  = LambdaVar
  | UntypedLambdaAbs
  | NonTerminal<UntypedLambda>

export const prettyPrintUntypedLambda = (ut: UntypedLambda): string => {
  switch (ut.kind) {
    case 'lambda-var':
      return ut.name
    case 'lambda-abs':
      return `λ${ut.name}.${prettyPrintUntypedLambda(ut.body)}`
    case 'non-terminal':
      return `(${prettyPrintUntypedLambda(ut.lft)}` +
        `${prettyPrintUntypedLambda(ut.rgt)})`
  }
}
