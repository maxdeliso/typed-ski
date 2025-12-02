/**
 * Shared helpers for Nat type and literal identifiers.
 *
 * This module intentionally avoids depending on SKI/Church code so it can be
 * safely imported from low-level utilities such as the parser.
 */
import type { BaseType } from "../types/types.ts";
import { mkTypeVariable } from "../types/types.ts";

export const NAT_TYPE_NAME = "Nat";
export const NAT_LITERAL_PREFIX = "__trip_nat_literal__";

export const makeNatType = (): BaseType => mkTypeVariable(NAT_TYPE_NAME);

export const makeNatLiteralIdentifier = (value: bigint): string =>
  `${NAT_LITERAL_PREFIX}${value.toString()}`;

export const isNatLiteralIdentifier = (name: string): boolean =>
  name.startsWith(NAT_LITERAL_PREFIX);

export const parseNatLiteralIdentifier = (name: string): bigint | null => {
  if (!isNatLiteralIdentifier(name)) {
    return null;
  }
  const suffix = name.slice(NAT_LITERAL_PREFIX.length);
  try {
    return BigInt(suffix);
  } catch {
    return null;
  }
};
