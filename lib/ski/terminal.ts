import { RandomSeed } from 'random-seed';

export enum SKITerminalSymbol {
  S = 'S',
  K = 'K',
  I = 'I'
}

export interface SKITerminal {
  kind: 'terminal';
  sym: SKITerminalSymbol;
}

export const term = (sym: SKITerminalSymbol): SKITerminal => ({
  kind: 'terminal',
  sym
});

export const S = term(SKITerminalSymbol.S);
export const K = term(SKITerminalSymbol.K);
export const I = term(SKITerminalSymbol.I);

/**
 * @param rs the random seed to use.
 * @returns a randomly selected terminal symbol.
 */
export function generate (rs: RandomSeed): SKITerminal {
  const die = rs.intBetween(1, 3);

  if (die === 1) {
    return S;
  } else if (die === 2) {
    return K;
  } else if (die === 3) {
    return I;
  } else {
    throw new Error('error on line twenty eight');
  }
}
