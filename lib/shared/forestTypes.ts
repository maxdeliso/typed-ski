/**
 * Shared type definitions for evaluation forest data
 *
 * This module provides type definitions and utilities for working with
 * evaluation forest data structures used in SKI expression evaluation.
 *
 * @module
 */

import type { ArenaNode } from "./types.ts";

export type { ArenaNode };

/**
 * Represents a single step in an evaluation path
 */
export interface EvaluationStep {
  /** Source node ID */
  from: number;
  /** Target node ID */
  to: number;
}

/**
 * Represents a complete evaluation path from source to sink
 */
export interface EvaluationPath {
  /** Starting node ID */
  source: number;
  /** Ending node ID */
  sink: number;
  /** Sequence of evaluation steps */
  steps: EvaluationStep[];
  /** True if homeomorphic embedding cutoff occurred */
  hasCycle: boolean;
}

/**
 * Global information about the evaluation forest
 */
export interface GlobalInfo {
  /** Type identifier */
  type: "global";
  /** All nodes in the arena */
  nodes: ArenaNode[];
  /** Source node IDs */
  sources: number[];
  /** Sink node IDs */
  sinks: number[];
}

/**
 * Type guard to validate global info structure
 *
 * @param data - The data to validate
 * @returns True if data is a valid GlobalInfo object
 */
export function isValidGlobalInfo(data: unknown): data is GlobalInfo {
  return (
    typeof data === "object" &&
    data !== null &&
    "type" in data &&
    data.type === "global" &&
    "nodes" in data &&
    Array.isArray(data.nodes) &&
    "sources" in data &&
    Array.isArray(data.sources) &&
    "sinks" in data &&
    Array.isArray(data.sinks)
  );
}

/**
 * Type guard to validate evaluation path structure
 *
 * @param data - The data to validate
 * @returns True if data is a valid EvaluationPath object
 */
export function isValidEvaluationPath(data: unknown): data is EvaluationPath {
  return (
    typeof data === "object" &&
    data !== null &&
    "source" in data &&
    typeof data.source === "number" &&
    "sink" in data &&
    typeof data.sink === "number" &&
    "steps" in data &&
    Array.isArray(data.steps) &&
    "hasCycle" in data &&
    typeof data.hasCycle === "boolean" &&
    data.steps.every((step) =>
      typeof step === "object" &&
      step !== null &&
      "from" in step &&
      typeof step.from === "number" &&
      "to" in step &&
      typeof step.to === "number"
    )
  );
}

/**
 * Helper function to get a label for a node
 *
 * @param _globalInfo - Global info (unused but kept for API consistency)
 * @param nodeId - The node ID to generate a label for
 * @returns A string label for the node
 */
export function getNodeLabel(_globalInfo: GlobalInfo, nodeId: number): string {
  return `node_${nodeId}`;
}
