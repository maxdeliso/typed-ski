/**
 * Arena-based memory management for SKI expressions
 *
 * This module provides arena-based memory management for efficient
 * representation and manipulation of SKI expressions in memory.
 *
 * @module
 */

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
}

/**
 * Type alias for arena node IDs
 */
export type ArenaNodeId = number;
