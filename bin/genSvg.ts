#!/usr/bin/env -S deno run --allow-read --allow-write --allow-run --unstable-worker-options

/**
 * SKI Evaluation Forest SVG Generator
 *
 * Generates SVG visualizations of SKI evaluation forests from JSONL data.
 * Creates DOT files and converts them to SVG using Graphviz's sfdp layout.
 */

import type {
  EvaluationPath,
  GlobalInfo,
  NodeLabel,
} from "../lib/shared/forestTypes.ts";
import {
  getNodeLabel,
  isValidEvaluationPath,
  isValidGlobalInfo,
  isValidNodeLabel,
} from "../lib/shared/forestTypes.ts";

import { VERSION } from "../lib/shared/version.ts";

interface CLIArgs {
  symbolCount: number;
  inputFile?: string;
  outputDir: string;
  verbose: boolean;
  concurrency: number;
}

function parseArgs(): CLIArgs {
  const args = Deno.args;

  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    Deno.exit(0);
  }

  if (args.includes("--version") || args.includes("-v")) {
    console.log(`genSvg v${VERSION}`);
    Deno.exit(0);
  }

  const verbose = args.includes("--verbose");

  // Parse concurrency option
  const concurrencyIndex = args.findIndex((arg) =>
    arg.startsWith("--concurrency=")
  );
  const defaultConcurrency = typeof navigator !== "undefined" &&
      typeof navigator.hardwareConcurrency === "number"
    ? navigator.hardwareConcurrency
    : 64;
  const concurrency = concurrencyIndex !== -1
    ? Number.parseInt(args[concurrencyIndex].split("=")[1], 10)
    : defaultConcurrency;

  const nonFlagArgs = args.filter((arg) => !arg.startsWith("--"));

  if (nonFlagArgs.length === 0) {
    console.error("Error: symbolCount is required");
    printHelp();
    Deno.exit(1);
  }

  const symbolCount = Number.parseInt(nonFlagArgs[0], 10);

  if (!Number.isFinite(symbolCount) || symbolCount <= 0) {
    console.error(
      `Error: symbolCount must be a positive integer; received '${
        nonFlagArgs[0]
      }'`,
    );
    Deno.exit(1);
  }

  const inputFile = nonFlagArgs[1];
  const outputDir = `forest${symbolCount}_svg`;

  return { symbolCount, inputFile, outputDir, verbose, concurrency };
}

function printHelp(): void {
  console.log(`SKI Evaluation Forest SVG Generator v${VERSION}

USAGE:
    genSvg <symbolCount> [inputFile.jsonl] [options]

ARGUMENTS:
    symbolCount      Number of terminal symbols (S/K/I) in the expressions
    inputFile.jsonl  Optional input JSONL file. If not provided, generates forest data

OPTIONS:
    --verbose, -v           Enable verbose output
    --concurrency=N         Number of concurrent sfdp processes (default: CPU count)
    --help, -h              Show this help message
    --version               Show version information

EXAMPLES:
    genSvg 3                    # Generate SVG for 3 symbols using generated data
    genSvg 4 forest.jsonl       # Generate SVG from existing forest data
    genSvg 5 forest.jsonl -v    # Generate with verbose output
    genSvg 3 --concurrency=32   # Use 32 concurrent processes

OUTPUT:
    Creates a directory 'forest{N}_svg' containing:
    - DOT files for each sink (sink_*.dot)
    - SVG files for each sink (sink_*.svg)
    - Generated using Graphviz's sfdp layout algorithm

REQUIREMENTS:
    - Graphviz with sfdp command must be installed
    - Input JSONL format: one evaluation path per line + global info
`);
}

async function generateForestData(
  symbolCount: number,
  _verbose: boolean,
): Promise<string> {
  const genForest = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--allow-read",
      "--allow-write",
      "--allow-run",
      "--unstable-worker-options",
      "bin/genForest.ts",
      String(symbolCount),
    ],
    stdout: "piped",
    stderr: "piped",
  });

  const forestProc = genForest.spawn();
  const forestOut = await forestProc.output();

  if (!forestOut.success) {
    console.error("Failed to generate forest data.");
    if (forestOut.stderr) {
      console.error(new TextDecoder().decode(forestOut.stderr));
    }
    Deno.exit(1);
  }

  return new TextDecoder().decode(forestOut.stdout);
}

async function readInputData(
  inputFile: string,
  _verbose: boolean,
): Promise<string> {
  try {
    return await Deno.readTextFile(inputFile);
  } catch (error) {
    console.error(`Error reading file ${inputFile}:`, (error as Error).message);
    Deno.exit(1);
  }
}

function parseJsonlData(jsonlContent: string, _verbose: boolean): {
  paths: EvaluationPath[];
  globalInfo: GlobalInfo;
  nodeLabels: Map<number, string>;
} {
  const lines = jsonlContent.trim().split("\n");
  const paths: EvaluationPath[] = [];
  let globalInfo: GlobalInfo | null = null;
  const nodeLabels = new Map<number, string>();

  for (const line of lines) {
    if (!line.trim()) continue;

    let data;
    try {
      data = JSON.parse(line);
    } catch (error) {
      console.error("Error parsing JSON line:", line, "with error:", error);
      continue;
    }

    if (data.type === "global") {
      if (isValidGlobalInfo(data)) {
        globalInfo = data;
      } else {
        console.error("Invalid global info structure:", data);
        Deno.exit(1);
      }
    } else if (data.type === "nodeLabel") {
      if (isValidNodeLabel(data)) {
        nodeLabels.set(data.id, data.label);
      } else {
        console.error("Invalid node label structure:", data);
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

  return { paths, globalInfo, nodeLabels };
}

/**
 * Escapes special characters in DOT file labels
 */
function escapeDotLabel(label: string): string {
  return label
    .replace(/\\/g, "\\\\") // Escape backslashes first
    .replace(/"/g, '\\"') // Escape quotes
    .replace(/\n/g, " ") // Replace newlines with spaces
    .replace(/\r/g, " "); // Replace carriage returns with spaces
}

function groupPathsBySink(
  paths: EvaluationPath[],
  _verbose: boolean,
): Map<number, { paths: EvaluationPath[]; hasCycle: boolean }> {
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

  return sinkGroups;
}

async function generateDotFiles(
  sinkGroups: Map<number, { paths: EvaluationPath[]; hasCycle: boolean }>,
  globalInfo: GlobalInfo,
  nodeLabels: Map<number, string>,
  outputDir: string,
  _verbose: boolean,
): Promise<string[]> {
  const dotFiles: string[] = [];

  for (const [sinkId, group] of sinkGroups) {
    const sinkLabel = getNodeLabel(nodeLabels, sinkId);
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

    const escapedSinkLabel = escapeDotLabel(sinkLabel);
    let dotContent = `digraph "Sink_${sinkId}_${escapedSinkLabel}" {\n`;
    dotContent +=
      `  node [shape=box, style=filled, fontname="Arial", fontsize=10];\n`;
    dotContent += `  edge [fontname="Arial", fontsize=8];\n\n`;

    for (const nodeId of nodes) {
      const label = getNodeLabel(nodeLabels, nodeId);
      const escapedLabel = escapeDotLabel(label);
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

      dotContent += `  ${nodeId} [label="${escapedLabel}", fillcolor="${color}"];\n`;
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
    dotFiles.push(dotPath);
  }

  return dotFiles;
}

async function generateSvgFiles(
  dotFiles: string[],
  concurrency: number,
  _verbose: boolean,
): Promise<void> {
  let nextIndex = 0;

  async function runSfdp(dotPath: string): Promise<void> {
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
    }
  }

  // Sliding window: start up to concurrency jobs, and as soon as one completes,
  // immediately start the next one from the queue
  type InFlightEntry = {
    index: number;
    promise: Promise<void>;
  };

  const inFlights: InFlightEntry[] = [];

  // Start initial batch
  while (nextIndex < dotFiles.length && inFlights.length < concurrency) {
    const index = nextIndex++;
    const promise = runSfdp(dotFiles[index]);
    inFlights.push({ index, promise });
  }

  // Process remaining jobs with sliding window
  while (inFlights.length > 0) {
    // Wait for any job to complete
    const doneEntry = await Promise.race(
      inFlights.map(async (entry) => {
        await entry.promise;
        return entry;
      }),
    );

    // Remove completed job
    const doneIndex = inFlights.findIndex((entry) => entry === doneEntry);
    if (doneIndex !== -1) {
      inFlights.splice(doneIndex, 1);
    }

    // Start next job if available
    if (nextIndex < dotFiles.length) {
      const index = nextIndex++;
      const promise = runSfdp(dotFiles[index]);
      inFlights.push({ index, promise });
    }
  }
}

async function main(): Promise<void> {
  const { symbolCount, inputFile, outputDir, verbose, concurrency } =
    parseArgs();

  // Create output directory
  await Deno.mkdir(outputDir, { recursive: true });

  // Get input data
  const jsonlContent = inputFile
    ? await readInputData(inputFile, verbose)
    : await generateForestData(symbolCount, verbose);

  // Parse JSONL data
  const { paths, globalInfo, nodeLabels } = parseJsonlData(
    jsonlContent,
    verbose,
  );

  // Group paths by sink
  const sinkGroups = groupPathsBySink(paths, verbose);

  // Generate DOT files
  const dotFiles = await generateDotFiles(
    sinkGroups,
    globalInfo,
    nodeLabels,
    outputDir,
    verbose,
  );

  // Generate SVG files
  await generateSvgFiles(dotFiles, concurrency, verbose);

  console.log(`Generated ${dotFiles.length} SVG files in ${outputDir}`);
}

if (import.meta.main) {
  await main();
}
