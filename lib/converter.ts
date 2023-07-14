import { NonTerminal, nt } from './nonterminal'
import { S, K, I, Terminal } from './terminal'
import { Expression } from './expression'
import { B, C } from './combinators'
import { LambdaVar } from './lambda'

type LambdaAbsMixed = {
  kind: 'lambda-abs',
  name: string,
  // eslint-disable-next-line no-use-before-define
  body: LambdaMixed
}

type LambdaMixed
  = Terminal
  | LambdaVar
  | LambdaAbsMixed
  | NonTerminal<LambdaMixed>

export type Lambda
  = LambdaVar
  | LambdaAbsMixed
  | NonTerminal<Lambda>

export class ConversionError extends Error { }

const mkAbstractMixed = (name: string, body: LambdaMixed): LambdaMixed => ({
  kind: 'lambda-abs',
  name,
  body
})

export const convertLambda = (lm: Lambda): Expression => {
  const mixed = convert(lm)
  return assertCombinator(mixed)
}

/**
 * NOTE: I referenced https://github.com/ngzhian/ski while coming up with this
 * implementation.
 * @see https://en.wikipedia.org/wiki/Combinatory_logic#Combinators_B,_C
 * @param lm - a lambda expression.
 * @returns an equivalent combinator expression.
 */
const convert = (lm: LambdaMixed): LambdaMixed => {
  switch (lm.kind) {
    case 'terminal':
    case 'lambda-var':
      // Rule 1. T[x] ⇒ x
      return lm
    case 'non-terminal':
      // Rule 2. T[(E₁ E₂)] ⇒ (T[E₁] T[E₂])
      return nt(convert(lm.lft), convert(lm.rgt))
    case 'lambda-abs':
      if (!free(lm.name, lm.body)) {
        // Rule 3. T[λx.E] ⇒ (K T[E])
        return nt(K, convert(lm.body))
      }

      switch (lm.body.kind) {
        case 'terminal':
          throw new ConversionError('encountered abstraction of a terminal')

        case 'lambda-var':
          if (lm.name === lm.body.name) {
            // Rule 4. T[λx.x] ⇒ I
            return I
          } else {
            throw new ConversionError('single variable non-match')
          }

        case 'lambda-abs': {
          const x = lm.name
          const y = lm.body.name
          const E = lm.body.body

          if (free(x, E)) {
            // Rule 5. T[λx.λy.E] ⇒ T[λx.T[λy.E]]
            return convert(
              mkAbstractMixed(
                x,
                convert(
                  mkAbstractMixed(y, E)
                )
              )
            )
          } else {
            throw new ConversionError('abs x abs y { x not referenced }')
          }
        }
        case 'non-terminal':
        {
          const x = lm.name
          const E1 = lm.body.lft
          const E2 = lm.body.rgt

          if (free(x, E1) && free(x, E2)) {
            // Rule 6. T[λx.(E₁ E₂)] ⇒ (S T[λx.E₁] T[λx.E₂])
            return nt(
              nt(S, convert(mkAbstractMixed(x, E1))),
              convert(mkAbstractMixed(x, E2))
            )
          } else if (free(x, E1) && !free(x, E2)) {
            // Rule 7. T[λx.(E₁ E₂)] ⇒ (C T[λx.E₁] T[E₂])
            return nt(
              nt(C, convert(mkAbstractMixed(x, E1))),
              convert(E2)
            )
          } else if (!free(x, E1) && free(x, E2)) {
            // Rule 8. T[λx.(E₁ E₂)] ⇒ (B T[E₁] T[λx.E₂])
            return nt(
              nt(B, convert(E1)),
              convert(mkAbstractMixed(x, E2))
            )
          } else {
            throw new ConversionError('x not free in E1 or E2')
          }
        }
      }
  }
}

const assertCombinator = (lm: LambdaMixed): Expression => {
  switch (lm.kind) {
    case 'terminal':
      return lm
    case 'non-terminal':
      if ((lm.lft.kind === 'lambda-var' || lm.lft.kind === 'lambda-abs') ||
          (lm.rgt.kind === 'lambda-var' || lm.rgt.kind === 'lambda-abs')) {
        throw new ConversionError('lambda abstraction detected in nt')
      }

      return nt<Expression>(assertCombinator(lm.lft), assertCombinator(lm.rgt))
    default:
      throw new ConversionError('lambda abstraction detected at top')
  }
}

const free = (needle: string, lm: LambdaMixed): boolean => {
  const fvs = freeVariables(lm)
  const idx = fvs.find(n => n === needle)
  return idx !== undefined
}

const freeVariables = (lm: LambdaMixed): Array<string> => {
  switch (lm.kind) {
    case 'lambda-var':
      return [lm.name]
    case 'non-terminal':
      return freeVariables(lm.lft).concat(freeVariables(lm.rgt))
    case 'lambda-abs':
      return freeVariables(lm.body).filter(v => v !== lm.name)
    case 'terminal':
      return []
  }
}
