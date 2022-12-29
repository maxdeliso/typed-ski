import { RandomSeed } from 'random-seed'

export enum TerminalSymbol {
  S = 'S',
  K = 'K',
  I = 'I'
}

export interface Terminal {
  kind: 'terminal';
  sym: TerminalSymbol;
}

export const term = (sym: TerminalSymbol): Terminal => ({
  kind: 'terminal',
  sym
})

export const S = term(TerminalSymbol.S)
export const K = term(TerminalSymbol.K)
export const I = term(TerminalSymbol.I)

/**
 * @param rs the random seed to use.
 * @returns a randomly selected terminal symbol.
 */
export function generate (rs: RandomSeed): Terminal {
  const die = rs.intBetween(1, 3)

  if (die === 1) {
    return S
  } else if (die === 2) {
    return K
  } else if (die === 3) {
    return I
  } else {
    throw new Error('error on line twenty eight')
  }
}
