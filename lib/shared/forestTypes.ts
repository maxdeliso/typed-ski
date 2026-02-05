/**
 * Shared type definitions for evaluation forest data
 *
 * This module provides type definitions and utilities for working with
 * evaluation forest data structures used in SKI expression evaluation.
 *
 * @module
 */

// NOTE: Global arena dumps have been removed from the forest format.

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
  /** Pretty-printed source expression (for debugging/inspection) */
  expr: string;
  /** Starting node ID */
  source: number;
  /** Ending node ID */
  sink: number;
  /** Sequence of evaluation steps */
  steps: EvaluationStep[];
  /** True if this expression reached a normal form within the configured max step limit */
  reachedNormalForm: boolean;
  /** Total number of reduction steps attempted (may exceed steps[].length due to truncation) */
  stepsTaken: number;
}

/**
 * Represents a node label mapping
 */
interface NodeLabel {
  /** Type identifier */
  type: "nodeLabel";
  /** Node ID */
  id: number;
  /** String representation of the node */
  label: string;
}

/**
 * Global information about the evaluation forest
 */
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
    "expr" in data &&
    typeof data.expr === "string" &&
    "source" in data &&
    typeof data.source === "number" &&
    "sink" in data &&
    typeof data.sink === "number" &&
    "steps" in data &&
    Array.isArray(data.steps) &&
    "reachedNormalForm" in data &&
    typeof data.reachedNormalForm === "boolean" &&
    "stepsTaken" in data &&
    typeof data.stepsTaken === "number" &&
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
 * Type guard to validate node label structure
 *
 * @param data - The data to validate
 * @returns True if data is a valid NodeLabel object
 */
export function isValidNodeLabel(data: unknown): data is NodeLabel {
  return (
    typeof data === "object" &&
    data !== null &&
    "type" in data &&
    data.type === "nodeLabel" &&
    "id" in data &&
    typeof data.id === "number" &&
    "label" in data &&
    typeof data.label === "string"
  );
}

/**
 * Helper function to get a label for a node
 *
 * @param nodeLabels - Map of node ID to string label
 * @param nodeId - The node ID to generate a label for
 * @returns A string label for the node
 */
export function getNodeLabel(
  nodeLabels: Map<number, string>,
  nodeId: number,
): string {
  return nodeLabels.get(nodeId) ?? `node_${nodeId}`;
}
