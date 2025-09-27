export enum SKITerminalSymbol {
  S = "S",
  K = "K",
  I = "I",
}

export interface SKITerminal {
  kind: "terminal";
  sym: SKITerminalSymbol;
}

export const term = (sym: SKITerminalSymbol): SKITerminal => ({
  kind: "terminal",
  sym,
});

export const S: SKITerminal = term(SKITerminalSymbol.S);
export const K: SKITerminal = term(SKITerminalSymbol.K);
export const I: SKITerminal = term(SKITerminalSymbol.I);
