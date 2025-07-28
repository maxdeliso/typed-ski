// Usage: deno run -A scripts/genSvg.ts <symbolCount> [inputFile.jsonl]

import type { EvaluationPath, GlobalInfo } from "./types.ts";
import {
  getNodeLabel,
  isValidEvaluationPath,
  isValidGlobalInfo,
} from "./types.ts";

const [nRaw, inputFile] = Deno.args;

if (!nRaw) {
  console.error(
    "Usage: deno run -A scripts/genSvg.ts <symbolCount> [inputFile.jsonl]",
  );
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

let jsonlContent: string;

if (inputFile) {
  console.error(`Step 1: Reading forest data from ${inputFile}...`);
  try {
    jsonlContent = await Deno.readTextFile(inputFile);
  } catch (error) {
    console.error(`Error reading file ${inputFile}:`, (error as Error).message);
    Deno.exit(1);
  }
} else {
  console.error(`Step 1: Generating forest JSONL...`);
  const genForest = new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "scripts/genForest.ts", String(n)],
    stdout: "piped",
  });
  const forestProc = genForest.spawn();
  const forestOut = await forestProc.output();
  if (!forestOut.success) {
    console.error("Failed to generate forest data.");
    console.error(new TextDecoder().decode(forestOut.stderr));
    Deno.exit(1);
  }
  jsonlContent = new TextDecoder().decode(forestOut.stdout);
}

const lines = jsonlContent.trim().split("\n");
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
  `Global info contains ${globalInfo.nodes.length} nodes`,
);

console.error(`Step 2: Grouping paths by sink...`);

const sinkGroups = new Map<
  number,
  { paths: EvaluationPath[]; hasCycle: boolean }
>();
for (const path of paths) {
  if (!sinkGroups.has(path.sink)) {
    sinkGroups.set(path.sink, { paths: [], hasCycle: false });
  }
  const group = sinkGroups.get(path.sink)!;
  group.paths.push(path);
  group.hasCycle = group.hasCycle || path.hasCycle;
}

console.error(`Found ${sinkGroups.size} unique sinks`);

console.error(`Step 3: Generating DOT files for each sink...`);

let dotFileCount = 0;
for (const [sinkId, group] of sinkGroups) {
  const sinkLabel = getNodeLabel(globalInfo, sinkId);
  const dotPath = `${outputDir}/sink_${sinkId}.dot`;

  const nodes = new Set<number>();
  const edges = new Set<string>();

  for (const path of group.paths) {
    nodes.add(path.source);
    nodes.add(path.sink);
    for (const step of path.steps) {
      nodes.add(step.from);
      nodes.add(step.to);
      edges.add(`${step.from} -> ${step.to}`);
    }
  }

  let dotContent = `digraph "Sink_${sinkId}_${sinkLabel}" {\n`;
  dotContent +=
    `  node [shape=box, style=filled, fontname="Arial", fontsize=10];\n`;
  dotContent += `  edge [fontname="Arial", fontsize=8];\n\n`;

  for (const nodeId of nodes) {
    const label = getNodeLabel(globalInfo, nodeId);
    const isSource = group.paths.some((p) => p.source === nodeId);
    const isSink = nodeId === sinkId;

    let color = "lightgray";
    if (isSource && isSink) {
      color = group.hasCycle ? "orange" : "lightblue";
    } else if (isSource) {
      color = "lightgreen";
    } else if (isSink) {
      color = group.hasCycle ? "orange" : "lightcoral";
    }

    dotContent += `  ${nodeId} [label="${label}", fillcolor="${color}"];\n`;
  }

  dotContent += `\n`;

  for (const edge of edges) {
    dotContent += `  ${edge};\n`;
  }

  if (group.hasCycle) {
    dotContent +=
      `  /* homeomorphic embedding cutoff: sink colored orange */\n`;
  }

  dotContent += `}\n`;
  await Deno.writeTextFile(dotPath, dotContent);
  dotFileCount++;
}

console.error(`Step 3 complete. Generated ${dotFileCount} DOT files`);
console.error(`Step 4: Running sfdp to generate SVG...`);

const dotFiles = [];
for await (const entry of Deno.readDir(outputDir)) {
  if (entry.isFile && entry.name.endsWith(".dot")) {
    dotFiles.push(`${outputDir}/${entry.name}`);
  }
}

const CONCURRENCY = 64;
let idx = 0;

async function runSfdp(dotPath: string) {
  const svgPath = dotPath.replace(/\.dot$/, ".svg");
  const sfdp = new Deno.Command("sfdp", {
    args: [
      "-Tsvg",
      "-Goverlap=scale",
      "-Gsplines=true",
      dotPath,
      "-o",
      svgPath,
    ],
    stdout: "null",
    stderr: "null",
  });
  const { success } = await sfdp.output();
  if (!success) {
    console.error(`sfdp failed for ${dotPath}`);
  } else {
    console.error(`Generated: ${dotPath} -> ${svgPath}`);
  }
}

while (idx < dotFiles.length) {
  const batch = dotFiles.slice(idx, idx + CONCURRENCY);
  await Promise.all(batch.map(runSfdp));
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
