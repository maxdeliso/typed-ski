// Shared type definitions for evaluation forest data

export interface EvaluationStep {
  from: number;
  to: number;
}

export interface EvaluationPath {
  source: number;
  sink: number;
  steps: EvaluationStep[];
}

export interface ArenaNode {
  id: number;
  kind: "terminal" | "non-terminal";
  sym?: string;
  left?: number;
  right?: number;
}

export interface GlobalInfo {
  type: "global";
  nodes: ArenaNode[];
  labels: Record<string, string>;
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
    "labels" in data &&
    typeof data.labels === "object" &&
    data.labels !== null &&
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

// Helper function to safely get a label for a node
export function getNodeLabel(globalInfo: GlobalInfo, nodeId: number): string {
  const label = globalInfo.labels[String(nodeId)];
  if (label === undefined) {
    console.error(`Warning: No label found for node ${nodeId}`);
    return `Node${nodeId}`;
  }
  return label;
}
