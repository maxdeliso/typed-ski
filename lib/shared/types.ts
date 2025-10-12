/**
 * Shared type definitions for arena evaluation and related functionality
 *
 * This module provides core type definitions used throughout the arena-based
 * evaluation system for SKI expressions.
 *
 * @module
 */

/**
 * Represents a node in the arena-based evaluation system
 */
export interface ArenaNode {
  /** Unique identifier for the node */
  id: number;
  /** Type of node: terminal (leaf) or non-terminal (internal) */
  kind: "terminal" | "non-terminal";
  /** Symbol for terminal nodes (S, K, I) */
  sym?: string;
  /** Left child node ID for non-terminal nodes */
  left?: number;
  /** Right child node ID for non-terminal nodes */
  right?: number;
}
