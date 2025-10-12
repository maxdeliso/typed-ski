// Shared type definitions for evaluation forest data

import type { ArenaNode } from "../lib/shared/types.ts";

export type { ArenaNode };

export interface EvaluationStep {
  from: number;
  to: number;
}

export interface EvaluationPath {
  source: number;
  sink: number;
  steps: EvaluationStep[];
  hasCycle: boolean; // true if homeomorphic embedding cutoff occurred
}

export interface GlobalInfo {
  type: "global";
  nodes: ArenaNode[];
  sources: number[];
  sinks: number[];
}

// Type guard to validate global info structure
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

// Type guard to validate evaluation path structure
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

// Helper function to get a label for a node
export function getNodeLabel(_globalInfo: GlobalInfo, nodeId: number): string {
  return `node_${nodeId}`;
}
