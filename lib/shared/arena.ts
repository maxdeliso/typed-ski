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
  B,
  BPrime,
  C,
  CPrime,
  EqU8,
  I,
  K,
  ReadOne,
  S,
  SPrime,
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
  /** Internal stack frame for iterative reduction (WASM only) */
  Continuation = 3,
  /** Paused reducer state (WASM only): host should resubmit */
  Suspension = 4,
  /** U8 literal (byte 0..255) */
  U8 = 5,
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
};

/**
 * Type alias for arena node IDs
 */
export type ArenaNodeId = number;
