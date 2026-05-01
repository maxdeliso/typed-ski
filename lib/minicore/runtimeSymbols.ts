import type { EffectKind, MiniType } from "./metadata.ts";

export type RuntimeSymbol = "trip_read_one" | "trip_write_one";

export interface RuntimeSymbolSignature {
  name: RuntimeSymbol;
  args: MiniType[];
  result: MiniType;
  effects: EffectKind;
}

const u8: MiniType = { kind: "u8" };
const unit: MiniType = { kind: "unit" };

export const TRIP_RUNTIME_SYMBOLS: ReadonlyMap<
  RuntimeSymbol,
  RuntimeSymbolSignature
> = new Map([
  [
    "trip_read_one",
    {
      name: "trip_read_one",
      args: [],
      result: u8,
      effects: "io",
    },
  ],
  [
    "trip_write_one",
    {
      name: "trip_write_one",
      args: [u8],
      result: unit,
      effects: "io",
    },
  ],
]);

export function getRuntimeSymbolSignature(
  name: RuntimeSymbol,
): RuntimeSymbolSignature {
  const signature = TRIP_RUNTIME_SYMBOLS.get(name);
  if (!signature) {
    throw new Error(`Unknown Trip runtime symbol ${name}`);
  }
  return signature;
}
