#!/usr/bin/env -S deno run --allow-read --allow-write --allow-run

/**
 * SKI Evaluation Forest SVG Generator
 *
 * Generates SVG visualizations of SKI evaluation forests from JSONL data.
 * Creates DOT files and converts them to SVG using Graphviz's sfdp layout.
 */

import type { EvaluationPath, GlobalInfo } from "../lib/shared/forestTypes.ts";
import {
  getNodeLabel,
  isValidEvaluationPath,
  isValidGlobalInfo,
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
  const concurrency = concurrencyIndex !== -1
    ? Number.parseInt(args[concurrencyIndex].split("=")[1], 10)
    : 64;

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
    --concurrency=N         Number of concurrent sfdp processes (default: 64)
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
  verbose: boolean,
): Promise<string> {
  if (verbose) {
    console.error(
      `Step 1: Generating forest JSONL for ${symbolCount} symbols...`,
    );
  }

  const genForest = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--allow-read",
      "--allow-write",
      "--allow-run",
      "bin/genForest.ts",
      String(symbolCount),
    ],
    stdout: "piped",
    stderr: verbose ? "inherit" : "null",
  });

  const forestProc = genForest.spawn();
  const forestOut = await forestProc.output();

  if (!forestOut.success) {
    console.error("Failed to generate forest data.");
    console.error(new TextDecoder().decode(forestOut.stderr));
    Deno.exit(1);
  }

  return new TextDecoder().decode(forestOut.stdout);
}

async function readInputData(
  inputFile: string,
  verbose: boolean,
): Promise<string> {
  if (verbose) {
    console.error(`Step 1: Reading forest data from ${inputFile}...`);
  }

  try {
    return await Deno.readTextFile(inputFile);
  } catch (error) {
    console.error(`Error reading file ${inputFile}:`, (error as Error).message);
    Deno.exit(1);
  }
}

function parseJsonlData(jsonlContent: string, verbose: boolean): {
  paths: EvaluationPath[];
  globalInfo: GlobalInfo;
} {
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

  if (verbose) {
    console.error(`Step 1 complete. Found ${paths.length} evaluation paths`);
    console.error(`Global info contains ${globalInfo.nodes.length} nodes`);
  }

  return { paths, globalInfo };
}

function groupPathsBySink(
  paths: EvaluationPath[],
  verbose: boolean,
): Map<number, { paths: EvaluationPath[]; hasCycle: boolean }> {
  if (verbose) {
    console.error(`Step 2: Grouping paths by sink...`);
  }

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

  if (verbose) {
    console.error(`Found ${sinkGroups.size} unique sinks`);
  }

  return sinkGroups;
}

async function generateDotFiles(
  sinkGroups: Map<number, { paths: EvaluationPath[]; hasCycle: boolean }>,
  globalInfo: GlobalInfo,
  outputDir: string,
  verbose: boolean,
): Promise<string[]> {
  if (verbose) {
    console.error(`Step 3: Generating DOT files for each sink...`);
  }

  const dotFiles: string[] = [];

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
    dotFiles.push(dotPath);
  }

  if (verbose) {
    console.error(`Step 3 complete. Generated ${dotFiles.length} DOT files`);
  }

  return dotFiles;
}

async function generateSvgFiles(
  dotFiles: string[],
  concurrency: number,
  verbose: boolean,
): Promise<void> {
  if (verbose) {
    console.error(`Step 4: Running sfdp to generate SVG...`);
  }

  let idx = 0;

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
    } else if (verbose) {
      console.error(`Generated: ${dotPath} -> ${svgPath}`);
    }
  }

  while (idx < dotFiles.length) {
    const batch = dotFiles.slice(idx, idx + concurrency);
    await Promise.all(batch.map(runSfdp));
    idx += concurrency;

    if (verbose) {
      console.error(
        `Processed ${
          Math.min(idx, dotFiles.length)
        } / ${dotFiles.length} SVG files (${
          ((Math.min(idx, dotFiles.length) / dotFiles.length) * 100).toFixed(2)
        }%)`,
      );
    }
  }
}

async function main(): Promise<void> {
  const { symbolCount, inputFile, outputDir, verbose, concurrency } =
    parseArgs();

  if (verbose) {
    console.error(
      `Arguments: symbolCount=${symbolCount}, inputFile=${
        inputFile || "generated"
      }, outputDir=${outputDir}, concurrency=${concurrency}`,
    );
  }

  // Create output directory
  await Deno.mkdir(outputDir, { recursive: true });

  // Get input data
  const jsonlContent = inputFile
    ? await readInputData(inputFile, verbose)
    : await generateForestData(symbolCount, verbose);

  // Parse JSONL data
  const { paths, globalInfo } = await parseJsonlData(jsonlContent, verbose);

  // Group paths by sink
  const sinkGroups = groupPathsBySink(paths, verbose);

  // Generate DOT files
  const dotFiles = await generateDotFiles(
    sinkGroups,
    globalInfo,
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
