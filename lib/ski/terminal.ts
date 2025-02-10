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
