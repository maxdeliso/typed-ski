#!/usr/bin/env -S deno run --allow-read --allow-write --allow-run

/**
 * SKI Evaluation Forest SVG Generator
 *
 * Generates SVG visualizations of SKI evaluation forests from JSONL data.
 * Creates DOT files and converts them to SVG using Graphviz's sfdp layout.
 */

import type { EvaluationPath } from "../lib/shared/forestTypes.ts";
import {
  getNodeLabel,
  isValidEvaluationPath,
  isValidNodeLabel,
} from "../lib/shared/forestTypes.ts";

import { VERSION } from "../lib/shared/version.ts";

interface CLIArgs {
  symbolCount: number;
  inputFile?: string;
  outputDir: string;
  verbose: boolean;
  concurrency: number;
  maxSteps: number;
  genForestNoLabels: boolean;
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

  // Parse --max-steps (forwarded to genForest when generating data)
  // Default is intentionally lower than genForest's default: genSvg is typically used
  // interactively, and huge step budgets make the tail latency (hard/divergent terms)
  // dominate wall-clock time.
  let maxSteps = 2000;
  let maxStepsIndex = -1;
  for (let i = args.length - 1; i >= 0; i--) {
    if (args[i] === "--max-steps") {
      maxStepsIndex = i;
      break;
    }
  }
  if (maxStepsIndex >= 0 && maxStepsIndex < args.length - 1) {
    const maxStepsValue = args[maxStepsIndex + 1];
    if (maxStepsValue === undefined) {
      console.error("Error: --max-steps requires a value");
      Deno.exit(1);
    }
    const parsed = Number.parseInt(maxStepsValue, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      console.error(
        `Error: --max-steps must be a positive integer; received '${maxStepsValue}'`,
      );
      Deno.exit(1);
    }
    maxSteps = parsed;
  }

  // Parse concurrency option
  const concurrencyIndex = args.findIndex((arg) =>
    arg.startsWith("--concurrency=")
  );
  const defaultConcurrency = typeof navigator !== "undefined" &&
      typeof navigator.hardwareConcurrency === "number"
    ? navigator.hardwareConcurrency
    : 64;
  let concurrency = defaultConcurrency;
  if (concurrencyIndex !== -1) {
    const concurrencyArg = args[concurrencyIndex];
    if (concurrencyArg === undefined) {
      console.error("Error: Invalid --concurrency option");
      Deno.exit(1);
    }
    const [_flag, concurrencyValue] = concurrencyArg.split("=", 2);
    if (concurrencyValue === undefined || concurrencyValue.length === 0) {
      console.error("Error: --concurrency requires a value");
      Deno.exit(1);
    }
    const parsedConcurrency = Number.parseInt(concurrencyValue, 10);
    if (!Number.isFinite(parsedConcurrency) || parsedConcurrency <= 0) {
      console.error(
        `Error: --concurrency must be a positive integer; received '${concurrencyValue}'`,
      );
      Deno.exit(1);
    }
    concurrency = parsedConcurrency;
  }

  const nonFlagArgs = args.filter((arg, index) => {
    if (arg.startsWith("--")) return false;
    if (index > 0 && args[index - 1] === "--max-steps") return false;
    return true;
  });

  if (nonFlagArgs.length === 0) {
    console.error("Error: symbolCount is required");
    printHelp();
    Deno.exit(1);
  }

  const symbolCountArg = nonFlagArgs[0];
  if (symbolCountArg === undefined) {
    console.error("Error: symbolCount is required");
    printHelp();
    Deno.exit(1);
  }
  const symbolCount = Number.parseInt(symbolCountArg, 10);

  if (!Number.isFinite(symbolCount) || symbolCount <= 0) {
    console.error(
      `Error: symbolCount must be a positive integer; received '${symbolCountArg}'`,
    );
    Deno.exit(1);
  }

  const inputFile = nonFlagArgs[1];
  const outputDir = `forest${symbolCount}_svg`;

  // Heuristic defaults for large forests: avoid massive post-processing costs.
  // - node labels can be extremely expensive at n>=6 (many unique nodes to pretty-print)
  const genForestNoLabels = args.includes("--no-labels") || symbolCount >= 6;

  return {
    symbolCount,
    inputFile,
    outputDir,
    verbose,
    concurrency,
    maxSteps,
    genForestNoLabels,
  };
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
    --max-steps <N>         Max reduction steps per expression when generating forest data (default: 2000)
    --no-labels             When generating forest data, skip nodeLabel emission (faster; labels fallback to node_<id>)
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
    - Input JSONL format: one evaluation path per line (+ optional nodeLabel)
`);
}

async function generateForestData(
  symbolCount: number,
  maxSteps: number,
  genForestNoLabels: boolean,
  verbose: boolean,
): Promise<string> {
  if (verbose) {
    console.error(
      `[genSvg] generating forest data via genForest (n=${symbolCount}, maxSteps=${maxSteps}, noLabels=${genForestNoLabels})`,
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
      "--max-steps",
      String(maxSteps),
      ...(genForestNoLabels ? ["--no-labels"] : []),
      "--progress",
    ],
    stdout: "piped",
    // genForest progress is printed to stderr; inherit so genSvg doesn't look "hung".
    stderr: "inherit",
  });

  const forestProc = genForest.spawn();
  const forestOut = await forestProc.output();

  if (!forestOut.success) {
    console.error("Failed to generate forest data.");
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
  nodeLabels: Map<number, string>;
} {
  const lines = jsonlContent.trim().split("\n");
  const paths: EvaluationPath[] = [];
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

    if (data.type === "nodeLabel") {
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

  return { paths, nodeLabels };
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
): Map<number, { paths: EvaluationPath[] }> {
  const sinkGroups = new Map<number, { paths: EvaluationPath[] }>();

  for (const path of paths) {
    if (!sinkGroups.has(path.sink)) {
      sinkGroups.set(path.sink, { paths: [] });
    }
    const group = sinkGroups.get(path.sink)!;
    group.paths.push(path);
  }

  return sinkGroups;
}

async function generateDotFiles(
  sinkGroups: Map<number, { paths: EvaluationPath[] }>,
  nodeLabels: Map<number, string>,
  outputDir: string,
  verbose: boolean,
): Promise<string[]> {
  const dotFiles: string[] = [];

  for (const [sinkId, group] of sinkGroups) {
    const sinkLabel = getNodeLabel(nodeLabels, sinkId);
    const dotPath = `${outputDir}/sink_${sinkId}.dot`;

    const totalSteps = group.paths.reduce((acc, p) => acc + p.steps.length, 0);
    const sourceIds = new Set<number>();
    const nonNormalSources = new Set<number>();
    for (const p of group.paths) {
      sourceIds.add(p.source);
      if (!p.reachedNormalForm) nonNormalSources.add(p.source);
    }

    if (verbose) {
      console.error(
        `[genSvg] sink=${sinkId} paths=${group.paths.length} steps=${totalSteps} sources=${sourceIds.size}`,
      );
    }

    const escapedSinkLabel = escapeDotLabel(sinkLabel);
    let dotContent = `digraph "Sink_${sinkId}_${escapedSinkLabel}" {\n`;
    dotContent +=
      `  node [shape=box, style=filled, fontname="Arial", fontsize=10];\n`;
    dotContent += `  edge [fontname="Arial", fontsize=8];\n\n`;

    const nodes = new Set<number>();
    const edges: string[] = [];

    for (const path of group.paths) {
      nodes.add(path.source);
      nodes.add(path.sink);
      for (const step of path.steps) {
        nodes.add(step.from);
        nodes.add(step.to);
        // Reverse edges (sink-rooted view) for generally more legible layout.
        edges.push(`${step.to} -> ${step.from}`);
      }
    }

    for (const nodeId of nodes) {
      const label = getNodeLabel(nodeLabels, nodeId);
      const escapedLabel = escapeDotLabel(label);
      const isSource = sourceIds.has(nodeId);
      const isSink = nodeId === sinkId;

      let color = "lightgray";
      if (isSource && isSink) {
        color = "lightblue";
      } else if (isSource) {
        color = nonNormalSources.has(nodeId) ? "orange" : "lightgreen";
      } else if (isSink) {
        color = "lightcoral";
      }

      dotContent +=
        `  ${nodeId} [label="${escapedLabel}", fillcolor="${color}"];\n`;
    }

    dotContent += `\n`;

    // Write edges without deduplication (dedup can be very expensive at this scale).
    for (const edge of edges) {
      dotContent += `  ${edge};\n`;
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
  verbose: boolean,
): Promise<void> {
  let nextIndex = 0;

  const startedAt = Date.now();
  const encoder = new TextEncoder();
  let completed = 0;
  let failed = 0;
  let lastReportAtMs = 0;

  const fmtSec = (ms: number) => (ms / 1000).toFixed(1);
  const maybeReport = (force: boolean) => {
    const now = Date.now();
    if (!force && now - lastReportAtMs < 750) return;
    lastReportAtMs = now;
    const elapsedMs = now - startedAt;
    const rate = completed > 0 ? (completed / (elapsedMs / 1000)) : 0;
    const remaining = dotFiles.length - completed;
    const etaSec = rate > 0 ? (remaining / rate) : Infinity;
    const msg =
      `[genSvg] sfdp ${completed}/${dotFiles.length} running=${inFlights.length} failed=${failed} elapsed=${
        fmtSec(elapsedMs)
      }s` +
      (Number.isFinite(etaSec) ? ` eta=${etaSec.toFixed(0)}s` : "") +
      (rate > 0 ? ` rate=${rate.toFixed(1)}/s` : "");
    // Update in-place to avoid flooding logs; end with newline at completion.
    Deno.stderr.writeSync(encoder.encode(`${msg}\r`));
    if (verbose) {
      // In verbose mode, also emit a newline occasionally so logs are readable.
      if (force) Deno.stderr.writeSync(encoder.encode("\n"));
    }
  };

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
      failed++;
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
    const dotPath = dotFiles[index];
    if (dotPath === undefined) {
      throw new Error(`Internal error: missing DOT path at index ${index}`);
    }
    const promise = runSfdp(dotPath);
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
    completed++;
    maybeReport(false);

    // Start next job if available
    if (nextIndex < dotFiles.length) {
      const index = nextIndex++;
      const dotPath = dotFiles[index];
      if (dotPath === undefined) {
        throw new Error(`Internal error: missing DOT path at index ${index}`);
      }
      const promise = runSfdp(dotPath);
      inFlights.push({ index, promise });
    }
  }

  // Final progress line
  maybeReport(true);
  // Ensure the progress line doesn't leave the cursor mid-line.
  Deno.stderr.writeSync(encoder.encode("\n"));
}

async function main(): Promise<void> {
  const {
    symbolCount,
    inputFile,
    outputDir,
    verbose,
    concurrency,
    maxSteps,
    genForestNoLabels,
  } = parseArgs();

  // Create output directory
  await Deno.mkdir(outputDir, { recursive: true });

  // Get input data
  const jsonlContent = inputFile
    ? await readInputData(inputFile, verbose)
    : await generateForestData(
      symbolCount,
      maxSteps,
      genForestNoLabels,
      verbose,
    );

  // Parse JSONL data
  const { paths, nodeLabels } = parseJsonlData(
    jsonlContent,
    verbose,
  );

  // Group paths by sink
  const sinkGroups = groupPathsBySink(paths, verbose);

  // Generate DOT files
  const dotFiles = await generateDotFiles(
    sinkGroups,
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
