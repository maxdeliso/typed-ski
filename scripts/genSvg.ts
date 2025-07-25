// Usage: deno run -A scripts/genSvg.ts <symbolCount>

import type { EvaluationPath, GlobalInfo } from "./types.ts";
import {
  getNodeLabel,
  isValidEvaluationPath,
  isValidGlobalInfo,
} from "./types.ts";

const [nRaw] = Deno.args;

if (!nRaw) {
  console.error("Usage: deno run -A scripts/genSvg.ts <symbolCount>");
  Deno.exit(1);
}

const n = Number.parseInt(nRaw, 10);

if (!Number.isFinite(n) || n <= 0) {
  console.error(
    `symbolCount must be a positive integer; received \`${nRaw}\`.`,
  );
  Deno.exit(1);
}

const outputDir = `forest${n}_svg`;
await Deno.mkdir(outputDir, { recursive: true });

console.error(`Step 1: Generating forest JSONL...`);

const genForest = new Deno.Command(Deno.execPath(), {
  args: ["run", "-A", "scripts/generateforest.ts", String(n)],
  stdout: "piped",
});
const forestProc = genForest.spawn();
const forestOut = await forestProc.output();

// Parse the JSONL output
const lines = new TextDecoder().decode(forestOut.stdout).trim().split("\n");
const paths: EvaluationPath[] = [];
let globalInfo: GlobalInfo | null = null;

for (const line of lines) {
  if (!line.trim()) continue;
  const data = JSON.parse(line);
  if (data.type === "global") {
    if (isValidGlobalInfo(data)) {
      globalInfo = data;
    } else {
      console.error("Invalid global info structure:", data);
      Deno.exit(1);
    }
  } else {
    if (isValidEvaluationPath(data)) {
      paths.push(data);
    } else {
      console.error("Invalid evaluation path structure:", data);
      Deno.exit(1);
    }
  }
}

if (!globalInfo) {
  console.error("No global info found in JSONL output");
  Deno.exit(1);
}

console.error(`Step 1 complete. Found ${paths.length} evaluation paths`);
console.error(
  `Global info contains ${Object.keys(globalInfo.labels).length} labels`,
);

console.error(`Step 2: Grouping paths by sink...`);

// Group paths by sink
const sinkGroups = new Map<number, EvaluationPath[]>();
for (const path of paths) {
  if (!sinkGroups.has(path.sink)) {
    sinkGroups.set(path.sink, []);
  }
  sinkGroups.get(path.sink)!.push(path);
}

console.error(`Found ${sinkGroups.size} unique sinks`);

console.error(`Step 3: Generating DOT files for each sink...`);

// Generate DOT file for each sink
let dotFileCount = 0;
for (const [sinkId, sinkPaths] of sinkGroups) {
  const sinkLabel = getNodeLabel(globalInfo, sinkId);
  const dotPath = `${outputDir}/sink_${sinkId}_${
    sinkLabel.replace(/[^a-zA-Z0-9]/g, "_")
  }.dot`;

  // Collect all nodes and edges for this sink
  const nodes = new Set<number>();
  const edges = new Set<string>();

  for (const path of sinkPaths) {
    nodes.add(path.source);
    nodes.add(path.sink);
    for (const step of path.steps) {
      nodes.add(step.from);
      nodes.add(step.to);
      edges.add(`${step.from} -> ${step.to}`);
    }
  }

  // Generate DOT content
  let dotContent = `digraph "Sink_${sinkId}_${sinkLabel}" {\n`;
  dotContent += `  rankdir=TB;\n`;
  dotContent +=
    `  node [shape=box, style=filled, fontname="Arial", fontsize=10];\n`;
  dotContent += `  edge [fontname="Arial", fontsize=8];\n\n`;

  // Add nodes
  for (const nodeId of nodes) {
    const label = getNodeLabel(globalInfo, nodeId);

    const isSource = sinkPaths.some((p) => p.source === nodeId);
    const isSink = nodeId === sinkId;

    let color = "lightgray";
    if (isSource && isSink) {
      color = "lightblue"; // Self-reducing
    } else if (isSource) {
      color = "lightgreen"; // Source only
    } else if (isSink) {
      color = "lightcoral"; // Sink only
    }

    dotContent += `  ${nodeId} [label="${label}", fillcolor="${color}"];\n`;
  }

  dotContent += `\n`;

  // Add edges
  for (const edge of edges) {
    dotContent += `  ${edge};\n`;
  }

  dotContent += `}\n`;

  await Deno.writeTextFile(dotPath, dotContent);
  dotFileCount++;
}

console.error(`Step 3 complete. Generated ${dotFileCount} DOT files`);

console.error(`Step 4: Running neato to generate SVG...`);

// Run neato on all DOT files
const dotFiles = [];
for await (const entry of Deno.readDir(outputDir)) {
  if (entry.isFile && entry.name.endsWith(".dot")) {
    dotFiles.push(`${outputDir}/${entry.name}`);
  }
}

const CONCURRENCY = 64;
let idx = 0;

async function runNeato(dotPath: string) {
  const svgPath = dotPath.replace(/\.dot$/, ".svg");
  const neato = new Deno.Command("neato", {
    args: [
      "-Tsvg",
      "-Goverlap=scale",
      "-Gsplines=true",
      "-Gnodesep=1.0",
      "-Granksep=2.0",
      dotPath,
      "-o",
      svgPath,
    ],
    stdout: "null",
    stderr: "null",
  });
  const { success } = await neato.output();
  if (!success) {
    console.error(`neato failed for ${dotPath}`);
  }
}

while (idx < dotFiles.length) {
  const batch = dotFiles.slice(idx, idx + CONCURRENCY);
  await Promise.all(batch.map(runNeato));
  idx += CONCURRENCY;
  console.error(
    `Processed ${
      Math.min(idx, dotFiles.length)
    } / ${dotFiles.length} SVG files (${
      ((Math.min(idx, dotFiles.length) / dotFiles.length) * 100).toFixed(2)
    }%)`,
  );
}

console.log(`Generated ${dotFiles.length} SVG files in ${outputDir}`);
