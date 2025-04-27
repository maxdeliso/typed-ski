/**
 * In the arena evaluator, every SKI expression gets its own numeric index.
 * This is used to accelerate term evaluation.
 */
export type ArenaNodeId = number;

export const enum ArenaKind { Terminal = 0, NonTerm = 1 }

export const enum ArenaSym  { S = 1, K = 2, I = 3 }

export const EMPTY = 0xffffffff;
