#!/usr/bin/env -S deno run --allow-read --allow-run --unstable-worker-options

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
  ResubmissionLimitExceededError,
} from "../lib/evaluator/parallelArenaEvaluator.ts";
import type { EvaluationStep } from "../lib/shared/forestTypes.ts";

import { VERSION } from "../lib/shared/version.ts";

// Memoization for expression enumeration
const memo = new Map<number, SKIExpression[]>();

interface CLIArgs {
  symbolCount: number;
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

  if (nonFlagArgs.length > 1) {
    console.error(
      `Error: genForest writes to stdout; unexpected extra argument '${
        nonFlagArgs[1]
      }'`,
    );
    printHelp();
    Deno.exit(1);
  }

  return { symbolCount, verbose, maxSteps };
}

function printHelp(): void {
  console.log(`SKI Evaluation Forest Generator v${VERSION}

USAGE:
    genForest <symbolCount> [options]

ARGUMENTS:
    symbolCount    Number of terminal symbols (S/K/I) in each generated expression

OPTIONS:
    --verbose, -v      Enable verbose output
    --max-steps <N>    Maximum evaluation steps per expression (default: 100000)
    --help, -h         Show this help message
    --version          Show version information

EXAMPLES:
    genForest 3                    # Generate forest for 3 symbols, output to stdout
    genForest 4 > forest.jsonl     # Generate forest for 4 symbols, save to file
    genForest 5 -v > forest.jsonl  # Generate with verbose output

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

type EvalResult = {
  source: number;
  sink: number;
  steps: EvaluationStep[];
  hasCycle: boolean;
  hitStepLimit: boolean;
  arenaError: boolean;
  hitSubmitLimit: boolean;
};

function initEvalState(
  sourceArenaId: number,
): {
  source: number;
  currentId: number;
  seenIds: Set<number>;
  historyQueue: number[];
  steps: EvaluationStep[];
  hasCycle: boolean;
  hitStepLimit: boolean;
  arenaError: boolean;
  hitSubmitLimit: boolean;
  done: boolean;
} {
  return {
    source: sourceArenaId,
    currentId: sourceArenaId,
    seenIds: new Set<number>([sourceArenaId]),
    historyQueue: [sourceArenaId],
    steps: [],
    hasCycle: false,
    hitStepLimit: false,
    arenaError: false,
    hitSubmitLimit: false,
    done: false,
  };
}

async function evaluateBatchParallel(
  evaluator: ParallelArenaEvaluatorWasm,
  sourceArenaId: number,
  maxSteps: number,
  onStep?: (stepsTaken: number) => void,
): Promise<EvalResult> {
  const MAX_HISTORY_SIZE = 10000;
  const MAX_PATH_STEPS = 10000;

  const st = initEvalState(sourceArenaId);
  let stepsTaken = 0;

  try {
    for (let step = 0; step < maxSteps; step++) {
      if (st.done) break;
      const nextId = await evaluator.reduceArenaNodeIdAsync(st.currentId);
      stepsTaken++;
      onStep?.(stepsTaken);

      if (nextId === st.currentId) {
        st.done = true; // normal form
        break;
      }
      if (st.seenIds.has(nextId)) {
        st.hasCycle = true;
        st.done = true;
        break;
      }

      if (st.steps.length < MAX_PATH_STEPS) {
        st.steps.push({ from: st.currentId, to: nextId });
      }

      st.currentId = nextId;
      st.seenIds.add(nextId);
      st.historyQueue.push(nextId);
      if (st.historyQueue.length > MAX_HISTORY_SIZE) {
        const removed = st.historyQueue.shift()!;
        st.seenIds.delete(removed);
      }
    }

    if (!st.done) {
      st.hitStepLimit = true;
      st.done = true;
    }
  } catch (error) {
    // Check if this is a resubmission limit error
    if (error instanceof ResubmissionLimitExceededError) {
      st.hitSubmitLimit = true;
      st.done = true;
    } else {
      st.arenaError = true;
      st.done = true;
    }
  }

  return {
    source: st.source,
    sink: st.currentId,
    steps: st.steps,
    hasCycle: st.hasCycle,
    hitStepLimit: st.hitStepLimit,
    arenaError: st.arenaError,
    hitSubmitLimit: st.hitSubmitLimit,
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

    // Pre-convert all expressions to arena node IDs sequentially to ensure
    // deterministic node ID assignment. This is critical for deterministic output.
    console.error(
      "Pre-converting expressions to arena nodes (deterministic order)...",
    );
    const allArenaIds: number[] = [];
    for (let i = 0; i < total; i++) {
      allArenaIds.push(evaluator.toArena(allExprs[i]));
      if ((i + 1) % 1000 === 0) {
        console.error(`  Converted ${i + 1}/${total} expressions...`);
      }
    }
    console.error(`All ${total} expressions converted to arena nodes.`);

    const sources = new Set<number>();
    const sinks = new Set<number>();

    // Configure workers to execute exactly one reduction step per submission.
    // The per-expression step limit is enforced in JS.
    evaluator.setMaxSteps(1);

    // Sliding concurrency window: when one expression completes, immediately start another.
    const CONCURRENCY = 8;
    let nextIndex = 0;
    let processed = 0;

    type SlotState =
      | { exprIndex: number; stepsTaken: number; startedAtMs: number }
      | null;
    const slots: SlotState[] = new Array(CONCURRENCY).fill(null);

    const getRingStats = () =>
      (evaluator as unknown as { getRingStatsSnapshot?: () => unknown })
        .getRingStatsSnapshot?.();
    const getDebugLockState = () => (evaluator.$.debugLockState
      ? evaluator.$.debugLockState()
      : undefined);

    const statusInterval = setInterval(() => {
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      const inFlight = slots.filter(Boolean).length;
      const slotSummary = slots
        .map(
          (s, i) => (s ? `${i}:${s.exprIndex + 1}@${s.stepsTaken}` : `${i}:-`),
        )
        .join(" ");
      console.error(
        `[Status] Processed: ${processed}/${total} (${
          ((processed / total) * 100).toFixed(2)
        }%) | In flight: ${inFlight}/${CONCURRENCY} | ` +
          `Total time: ${elapsed}s | Slots: ${slotSummary} | ` +
          `Ring: ${JSON.stringify(getRingStats() ?? {})} | ` +
          `resize_seq: ${getDebugLockState() ?? "n/a"}`,
      );
    }, 2000);

    try {
      type Done = {
        slot: number;
        exprIndex: number;
        result: EvalResult;
      };
      type InFlightEntry = {
        slot: number;
        exprIndex: number;
        promise: Promise<Done>;
      };

      let inFlights: InFlightEntry[] = [];

      const startSlot = (slot: number) => {
        if (nextIndex >= total) {
          return;
        }
        const exprIndex = nextIndex++;
        slots[slot] = { exprIndex, stepsTaken: 0, startedAtMs: Date.now() };

        const base = evaluateBatchParallel(
          evaluator,
          allArenaIds[exprIndex],
          maxSteps,
          (stepsTaken) => {
            const s = slots[slot];
            if (s) {
              s.stepsTaken = stepsTaken;
            }
          },
        );

        const promise = base.then((result) => ({ slot, exprIndex, result }));
        inFlights.push({ slot, exprIndex, promise });
      };

      for (let slot = 0; slot < CONCURRENCY; slot++) {
        startSlot(slot);
      }

      // Buffer for results to ensure deterministic output order
      const resultBuffer = new Map<number, EvalResult>();
      let nextExpectedIndex = 0;

      while (inFlights.length > 0 || resultBuffer.size > 0) {
        // Wait for next completion if we have in-flight work
        if (inFlights.length > 0) {
          const done = await Promise.race(
            inFlights.map((e) =>
              e.promise
            ),
          );
          inFlights = inFlights.filter((e) => e.slot !== done.slot);

          slots[done.slot] = null;
          processed++;
          sources.add(done.result.source);
          sinks.add(done.result.sink);

          // Buffer the result to maintain deterministic output order
          resultBuffer.set(done.exprIndex, done.result);

          // backfill this slot if more work remains
          startSlot(done.slot);
        }

        // Yield results in deterministic order (by exprIndex)
        while (resultBuffer.has(nextExpectedIndex)) {
          const result = resultBuffer.get(nextExpectedIndex)!;
          resultBuffer.delete(nextExpectedIndex);
          yield JSON.stringify(result);
          nextExpectedIndex++;
        }
      }
    } finally {
      clearInterval(statusInterval);
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
  const { symbolCount, verbose, maxSteps = 100000 } = parseArgs();

  if (verbose) {
    console.error(
      `Arguments: symbolCount=${symbolCount}, maxSteps=${maxSteps}`,
    );
  }

  console.error("Starting processing...");
  await streamToStdout(symbolCount, verbose, maxSteps);
}

if (import.meta.main) {
  await main();
}
