/**
 * Arena-based memory management for SKI expressions
 *
 * This module provides arena-based memory management for efficient
 * representation and manipulation of SKI expressions in memory.
 *
 * @module
 */

import type { SKIExpression } from "../ski/expression.ts";
import {
  AddU8,
  B,
  BPrime,
  C,
  CPrime,
  DivU8,
  EqU8,
  I,
  K,
  LtU8,
  ModU8,
  ReadOne,
  S,
  SPrime,
  SubU8,
  WriteOne,
} from "../ski/terminal.ts";

/**
 * Enumeration of arena node kinds
 */
export enum ArenaKind {
  /** Terminal node (leaf) */
  Terminal = 1,
  /** Non-terminal node (internal) */
  NonTerm = 2,
  /** U8 literal (byte 0..255) */
  U8 = 3,
}

export const CONTROL_PTR_BIT = 0x80000000;

export function isControlPtr(ptr: number): boolean {
  return (ptr & CONTROL_PTR_BIT) !== 0;
}

export function isValuePtr(ptr: number): boolean {
  return (ptr & CONTROL_PTR_BIT) === 0;
}

export function controlIndex(ptr: number): number {
  return ptr & ~CONTROL_PTR_BIT;
}

export function makeControlPtr(index: number): number {
  return (index | CONTROL_PTR_BIT) >>> 0;
}

/**
 * Enumeration of SKI symbols
 */
export enum ArenaSym {
  /** S combinator */
  S = 1,
  /** K combinator */
  K = 2,
  /** I combinator */
  I = 3,
  /** readOne terminal */
  ReadOne = 4,
  /** writeOne terminal */
  WriteOne = 5,
  /** B combinator: `B x y z -> x (y z) */
  B = 8,
  /** C combinator: `C x y z -> x z y` */
  C = 9,
  /** S' combinator (Turner PSI) */
  SPrime = 10,
  /** B' combinator (Turner B-prime) */
  BPrime = 11,
  /** C' combinator (Turner GAMMA) */
  CPrime = 12,
  /** eqU8 intrinsic */
  EqU8 = 13,
  /** ltU8 intrinsic */
  LtU8 = 14,
  /** divU8 intrinsic */
  DivU8 = 15,
  /** modU8 intrinsic */
  ModU8 = 16,
  /** addU8 intrinsic */
  AddU8 = 17,
  /** subU8 intrinsic */
  SubU8 = 18,
}

/**
 * Mapping from ArenaSym to SKIExpression.
 */
export const ARENA_SYM_TO_SKI: Record<ArenaSym, SKIExpression> = {
  [ArenaSym.S]: S,
  [ArenaSym.K]: K,
  [ArenaSym.I]: I,
  [ArenaSym.B]: B,
  [ArenaSym.C]: C,
  [ArenaSym.SPrime]: SPrime,
  [ArenaSym.BPrime]: BPrime,
  [ArenaSym.CPrime]: CPrime,
  [ArenaSym.ReadOne]: ReadOne,
  [ArenaSym.WriteOne]: WriteOne,
  [ArenaSym.EqU8]: EqU8,
  [ArenaSym.LtU8]: LtU8,
  [ArenaSym.DivU8]: DivU8,
  [ArenaSym.ModU8]: ModU8,
  [ArenaSym.AddU8]: AddU8,
  [ArenaSym.SubU8]: SubU8,
};

/**
 * Type alias for arena node IDs
 */
export type ArenaNodeId = number;
