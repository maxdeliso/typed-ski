/**
 * Shared type definitions for arena evaluation and related functionality.
 */

export interface ArenaNode {
  id: number;
  kind: "terminal" | "non-terminal";
  sym?: string;
  left?: number;
  right?: number;
}
