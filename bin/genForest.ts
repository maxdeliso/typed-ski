#!/usr/bin/env -S deno run --allow-read --allow-write --allow-run --unstable-worker-options

/**
 * SKI Evaluation Forest Generator
 *
 * Generates evaluation forests for SKI expressions with a given number of symbols.
 * Outputs JSONL format with evaluation paths and global arena information.
 */

import { apply } from "../lib/ski/expression.ts";
import { I, K, S } from "../lib/ski/terminal.ts";
import type { SKIExpression } from "../lib/ski/expression.ts";
import {
  ParallelArenaEvaluatorWasm,
} from "../lib/evaluator/parallelArenaEvaluator.ts";
import type { EvaluationStep } from "../lib/shared/forestTypes.ts";

import { VERSION } from "../lib/shared/version.ts";

// Memoization for expression enumeration
const memo = new Map<number, SKIExpression[]>();

interface CLIArgs {
  symbolCount: number;
  outputFile?: string;
  verbose: boolean;
  maxSteps?: number;
}

function parseArgs(): CLIArgs {
  const args = Deno.args;

  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    Deno.exit(0);
  }

  if (args.includes("--version") || args.includes("-v")) {
    console.log(`genForest v${VERSION}`);
    Deno.exit(0);
  }

  const verbose = args.includes("--verbose");

  // Find all --max-steps occurrences and use the last one
  let maxStepsIndex = -1;
  for (let i = args.length - 1; i >= 0; i--) {
    if (args[i] === "--max-steps") {
      maxStepsIndex = i;
      break;
    }
  }

  let maxSteps: number | undefined = undefined;
  if (maxStepsIndex >= 0 && maxStepsIndex < args.length - 1) {
    const maxStepsValue = args[maxStepsIndex + 1];
    const parsed = Number.parseInt(maxStepsValue, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      console.error(
        `Error: --max-steps must be a positive integer; received '${maxStepsValue}'`,
      );
      Deno.exit(1);
    }
    maxSteps = parsed;
  }

  // Filter out flags and their values
  const nonFlagArgs = args.filter((arg, index) => {
    if (arg.startsWith("--")) return false;
    // Also filter out the value after --max-steps
    if (index > 0 && args[index - 1] === "--max-steps") return false;
    return true;
  });

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

  const outputFile = nonFlagArgs[1];

  return { symbolCount, outputFile, verbose, maxSteps };
}

function printHelp(): void {
  console.log(`SKI Evaluation Forest Generator v${VERSION}

USAGE:
    genForest <symbolCount> [outputFile] [options]

ARGUMENTS:
    symbolCount    Number of terminal symbols (S/K/I) in each generated expression
    outputFile     Optional output file path. If not provided, outputs to stdout

OPTIONS:
    --verbose, -v      Enable verbose output
    --max-steps <N>    Maximum evaluation steps per expression (default: 100000)
    --help, -h         Show this help message
    --version          Show version information

EXAMPLES:
    genForest 3                    # Generate forest for 3 symbols, output to stdout
    genForest 4 forest.jsonl       # Generate forest for 4 symbols, save to file
    genForest 5 forest.jsonl -v   # Generate with verbose output

OUTPUT FORMAT:
    JSONL (JSON Lines) format with one evaluation path per line, followed by global info.
    Each line contains: source, sink, steps, hasCycle
    Final line contains: type, nodes, sources, sinks
`);
}

function enumerateExpressions(leaves: number): SKIExpression[] {
  if (memo.has(leaves)) return memo.get(leaves)!;

  let result: SKIExpression[] = [];

  if (leaves === 1) {
    result = [S, K, I];
  } else {
    for (let leftLeaves = 1; leftLeaves <= leaves - 1; leftLeaves++) {
      const rightLeaves = leaves - leftLeaves;
      for (const leftExpr of enumerateExpressions(leftLeaves)) {
        for (const rightExpr of enumerateExpressions(rightLeaves)) {
          result.push(apply(leftExpr, rightExpr));
        }
      }
    }
  }

  memo.set(leaves, result);
  return result;
}

function evaluateExpression(
  evaluator: ParallelArenaEvaluatorWasm,
  expr: SKIExpression,
  exprIndex: number,
  total: number,
  maxSteps: number,
): {
  source: number;
  sink: number;
  steps: EvaluationStep[];
  hasCycle: boolean;
  hitStepLimit: boolean;
  arenaError: boolean;
} {
  const exprStart = Date.now();
  const curId = evaluator.toArena(expr);

  // Track evaluation history for cycle detection (exact node ID matches only)
  // Use a sliding window to prevent unbounded memory growth
  const MAX_HISTORY_SIZE = 10000;
  const seenIds = new Set<number>([curId]);
  const historyQueue: number[] = [curId];
  const pathSteps: EvaluationStep[] = [];
  // Limit path storage to prevent unbounded memory growth
  const MAX_PATH_STEPS = 10000;
  let hasCycle = false;
  let currentId = curId;

  // Manual evaluation with cycle detection
  let hitStepLimit = false;
  let arenaError = false;
  for (let step = 0; step < maxSteps; step++) {
    // Report progress for long-running evaluations
    if (step > 0 && step % 10000 === 0) {
      const exprElapsed = ((Date.now() - exprStart) / 1000).toFixed(1);
      console.error(
        `Expression ${exprIndex}/${total}: ${step} steps in ${exprElapsed}s...`,
      );
    }

    try {
      // Use direct arena step to avoid toArena/fromArena conversion overhead
      const nextId = evaluator.stepOnceArena(currentId);

      // Check if no reduction occurred (same node ID returned)
      if (nextId === currentId) {
        break; // No more reduction possible
      }

      // Check for exact cycle (same node ID seen before)
      if (seenIds.has(nextId)) {
        hasCycle = true;
        break;
      }

      // Only store path steps up to a limit to prevent unbounded memory growth
      if (pathSteps.length < MAX_PATH_STEPS) {
        pathSteps.push({ from: currentId, to: nextId });
      }
      currentId = nextId;

      // Maintain sliding window of seen IDs
      seenIds.add(nextId);
      historyQueue.push(nextId);
      if (historyQueue.length > MAX_HISTORY_SIZE) {
        const removed = historyQueue.shift()!;
        // Remove from seenIds - we only track recent history for exact matches
        // This is safe because we still check cycles against the full recent history
        seenIds.delete(removed);
      }
    } catch (error) {
      // Catch WASM errors (e.g., arena capacity exceeded, OOM, invalid node IDs)
      arenaError = true;
      const exprElapsed = ((Date.now() - exprStart) / 1000).toFixed(1);
      console.error(
        `Warning: Expression ${exprIndex}/${total} failed after ${step} steps in ${exprElapsed}s: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      break;
    }
  }

  if (pathSteps.length >= maxSteps) {
    hitStepLimit = true;
    const exprElapsed = ((Date.now() - exprStart) / 1000).toFixed(1);
    console.error(
      `Warning: Expression ${exprIndex}/${total} hit step limit of ${maxSteps} after ${exprElapsed}s`,
    );
  }

  const finalId = currentId;
  return {
    source: curId,
    sink: finalId,
    steps: pathSteps,
    hasCycle,
    hitStepLimit,
    arenaError,
  };
}

export async function* generateEvaluationForest(
  symbolCount: number,
  maxSteps: number = 100000,
): AsyncGenerator<string, void, unknown> {
  const evaluator = await ParallelArenaEvaluatorWasm.create(8);

  try {
    const allExprs = enumerateExpressions(symbolCount);
    const total = allExprs.length;
    const start = Date.now();

    console.error(
      `Processing ${total} expressions with ${symbolCount} symbols each using 8 workers...`,
    );
    const sources = new Set<number>();
    const sinks = new Set<number>();

    // Process expressions in batches of 8 (one per worker)
    const BATCH_SIZE = 8;
    const STATUS_UPDATE_INTERVAL = 2000; // Update status every 2 seconds

    for (let i = 0; i < allExprs.length; i += BATCH_SIZE) {
      const batch = allExprs.slice(i, i + BATCH_SIZE);
      const batchStartTime = Date.now();

      // Start batch processing
      const batchPromises = batch.map((expr, batchIdx) =>
        Promise.resolve(evaluateExpression(
          evaluator,
          expr,
          i + batchIdx + 1,
          total,
          maxSteps,
        ))
      );

      // Show status while processing
      const showStatus = () => {
        const elapsed = ((Date.now() - start) / 1000).toFixed(1);
        const batchElapsed = ((Date.now() - batchStartTime) / 1000).toFixed(1);
        const processed = i;
        const inFlight = batch.length;
        console.error(
          `[Status] Processed: ${processed}/${total} (${
            ((processed / total) * 100).toFixed(2)
          }%) | ` +
            `In flight: ${inFlight} | Total time: ${elapsed}s | Batch time: ${batchElapsed}s`,
        );
      };

      // Show initial status
      showStatus();

      // Set up periodic status updates
      const statusInterval = setInterval(showStatus, STATUS_UPDATE_INTERVAL);

      const results = await Promise.all(batchPromises);
      clearInterval(statusInterval);

      // Show final status for this batch
      showStatus();

      for (const result of results) {
        sources.add(result.source);
        sinks.add(result.sink);
        yield JSON.stringify(result);
      }

      // Progress reporting
      const processed = Math.min(i + BATCH_SIZE, total);
      if (processed % 1000 === 0 || processed === total) {
        const elapsed = ((Date.now() - start) / 1000).toFixed(1);
        console.error(
          `Processed ${processed} / ${total} (${
            ((processed / total) * 100).toFixed(2)
          }%) in ${elapsed}s`,
        );
      }
    }

    console.error("Dumping arena (streaming)...");

    // Stream the JSON output to avoid memory issues with large arenas
    // We need to yield chunks of JSON to avoid exceeding string length limits
    let nodeCount = 0;
    const CHUNK_SIZE = 100000; // Yield JSON in chunks of 100k nodes

    // Start JSON object
    let jsonBuffer = '{"type":"global","nodes":[';

    let firstNode = true;
    let nodesInBuffer = 0;

    for (const chunk of evaluator.dumpArenaStreaming(10000)) {
      nodeCount += chunk.length;

      // Progress reporting for large dumps
      if (nodeCount % 1000000 === 0) {
        console.error(`  Dumped ${nodeCount} nodes...`);
      }

      // Serialize chunk and add to JSON buffer
      for (const node of chunk) {
        if (!firstNode) {
          jsonBuffer += ",";
        }
        jsonBuffer += JSON.stringify(node);
        firstNode = false;
        nodesInBuffer++;

        // Yield buffer when it gets large enough to avoid memory issues
        if (nodesInBuffer >= CHUNK_SIZE) {
          yield jsonBuffer;
          jsonBuffer = ""; // Reset buffer
          nodesInBuffer = 0;
        }
      }
    }

    console.error(`Arena contains ${nodeCount} nodes`);

    // Close nodes array and add sources/sinks
    jsonBuffer += '],"sources":';
    jsonBuffer += JSON.stringify(Array.from(sources));
    jsonBuffer += ',"sinks":';
    jsonBuffer += JSON.stringify(Array.from(sinks));
    jsonBuffer += "}";

    // Yield remaining JSON
    if (jsonBuffer) {
      yield jsonBuffer;
    }
  } finally {
    // Clean up workers
    evaluator.terminate();
  }
}

async function streamToFile(
  symbolCount: number,
  outputPath: string,
  verbose: boolean,
  maxSteps: number = 100000,
) {
  if (verbose) {
    console.error(`Writing output to ${outputPath}...`);
  }

  const file = await Deno.open(outputPath, {
    write: true,
    create: true,
    truncate: true,
  });
  const encoder = new TextEncoder();

  try {
    let inGlobalInfo = false;
    for await (const data of generateEvaluationForest(symbolCount, maxSteps)) {
      // Check if this is the start of global info
      if (data.startsWith('{"type":"global"')) {
        inGlobalInfo = true;
        await file.write(encoder.encode(data));
      } else if (inGlobalInfo) {
        // Continuation chunk of global info - no newline
        await file.write(encoder.encode(data));
        // Check if this is the end of global info (ends with })
        if (data.endsWith("}")) {
          await file.write(encoder.encode("\n"));
          inGlobalInfo = false;
        }
      } else {
        // Regular evaluation path - add newline
        await file.write(encoder.encode(data + "\n"));
      }
    }
    console.error(`Successfully wrote evaluation forest to ${outputPath}`);
  } finally {
    file.close();
  }
}

async function streamToStdout(
  symbolCount: number,
  verbose: boolean,
  maxSteps: number = 100000,
) {
  if (verbose) {
    console.error("Writing output to stdout...");
  }

  let inGlobalInfo = false;
  for await (const data of generateEvaluationForest(symbolCount, maxSteps)) {
    // Check if this is the start of global info
    if (data.startsWith('{"type":"global"')) {
      inGlobalInfo = true;
      Deno.stdout.writeSync(new TextEncoder().encode(data));
    } else if (inGlobalInfo) {
      // Continuation chunk of global info - no newline
      Deno.stdout.writeSync(new TextEncoder().encode(data));
      // Check if this is the end of global info (ends with })
      if (data.endsWith("}")) {
        Deno.stdout.writeSync(new TextEncoder().encode("\n"));
        inGlobalInfo = false;
      }
    } else {
      // Regular evaluation path - use console.log which adds newline
      console.log(data);
    }
  }
}

async function main(): Promise<void> {
  const { symbolCount, outputFile, verbose, maxSteps = 100000 } = parseArgs();

  if (verbose) {
    console.error(
      `Arguments: symbolCount=${symbolCount}, outputFile=${
        outputFile || "stdout"
      }, maxSteps=${maxSteps}`,
    );
  }

  console.error("Starting processing...");

  if (outputFile) {
    await streamToFile(symbolCount, outputFile, verbose, maxSteps);
  } else {
    await streamToStdout(symbolCount, verbose, maxSteps);
  }
}

if (import.meta.main) {
  await main();
}
