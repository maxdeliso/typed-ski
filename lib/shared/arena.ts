/**
 * Arena-based memory management for SKI expressions.
 *
 * This module provides arena-based memory management for efficient
 * representation and manipulation of SKI expressions in memory.
 *
 * @module
 */
export enum ArenaKind {
  Terminal = 1,
  NonTerm = 2,
}

export enum ArenaSym {
  S = 1,
  K = 2,
  I = 3,
}

export type ArenaNodeId = number;
