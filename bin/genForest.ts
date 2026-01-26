#!/usr/bin/env -S deno run --allow-read --allow-run

/**
 * SKI Evaluation Forest Generator
 *
 * Generates evaluation forests for SKI expressions with a given number of symbols.
 * Outputs JSONL format with evaluation paths and global arena information.
 */

import { apply, unparseSKI } from "../lib/ski/expression.ts";
import { I, K, S } from "../lib/ski/terminal.ts";
import type { SKIExpression } from "../lib/ski/expression.ts";
import { ArenaKind, ArenaSym } from "../lib/shared/arena.ts";
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
  workers?: number;
  progress: boolean;
  includeLabels: boolean;
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
  const progress = args.includes("--progress");
  const includeLabels = !args.includes("--no-labels");

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

  // Find all --workers occurrences and use the last one
  let workersIndex = -1;
  for (let i = args.length - 1; i >= 0; i--) {
    if (args[i] === "--workers") {
      workersIndex = i;
      break;
    }
  }

  let workers: number | undefined = undefined;
  if (workersIndex >= 0 && workersIndex < args.length - 1) {
    const workersValue = args[workersIndex + 1];
    const parsed = Number.parseInt(workersValue, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      console.error(
        `Error: --workers must be a positive integer; received '${workersValue}'`,
      );
      Deno.exit(1);
    }
    workers = parsed;
  }

  // Filter out flags and their values
  const nonFlagArgs = args.filter((arg, index) => {
    if (arg.startsWith("--")) return false;
    // Also filter out the value after --max-steps
    if (index > 0 && args[index - 1] === "--max-steps") return false;
    // Also filter out the value after --workers
    if (index > 0 && args[index - 1] === "--workers") return false;
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

  return {
    symbolCount,
    verbose,
    maxSteps,
    workers,
    progress,
    includeLabels,
  };
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
    --workers <N>      Worker count for parallel evaluation (default: navigator.hardwareConcurrency)
    --progress         Print high-level progress to stderr (keeps stdout clean JSONL)
    --no-labels        Skip emitting nodeLabel lines (faster; genSvg will fall back to node_<id>)
    --help, -h         Show this help message
    --version          Show version information

EXAMPLES:
    genForest 3                    # Generate forest for 3 symbols, output to stdout
    genForest 4 > forest.jsonl     # Generate forest for 4 symbols, save to file
    genForest 5 -v > forest.jsonl  # Generate with verbose output
    genForest 6 --max-steps 2000 --progress > forest.jsonl
    genForest 6 --no-labels --max-steps 1000 >/dev/null

OUTPUT FORMAT:
    JSONL (JSON Lines) format with one evaluation path per line, plus optional nodeLabel lines.
    Each evaluation path line contains: expr, source, sink, steps, reachedNormalForm, stepsTaken
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
  expr: string;
  source: number;
  sink: number;
  steps: EvaluationStep[];
  reachedNormalForm: boolean;
  stepsTaken: number;
};

function initEvalState(
  sourceArenaId: number,
): {
  source: number;
  currentId: number;
  seenIds: Set<number>;
  historyQueue: number[];
  steps: EvaluationStep[];
  reachedNormalForm: boolean;
  done: boolean;
} {
  return {
    source: sourceArenaId,
    currentId: sourceArenaId,
    seenIds: new Set<number>([sourceArenaId]),
    historyQueue: [sourceArenaId],
    steps: [],
    reachedNormalForm: false,
    done: false,
  };
}

/**
 * Returns true if there exists *any* reducible SKI redex anywhere in the expression:
 * - I x
 * - K x y
 * - S x y z
 *
 * This matters because with hash-consing, a reduction step can produce an
 * expression structurally identical to the input (e.g. Ω), which yields
 * `nextId === currentId` even though the term is still reducible.
 *
 * NOTE: We only call this in the rare `nextId === currentId` case, so an O(size)
 * scan is acceptable.
 */
function hasAnyRedex(
  evaluator: ParallelArenaEvaluatorWasm,
  nodeId: number,
): boolean {
  const kindOf = (id: number) => evaluator.$.kindOf(id) >>> 0;
  const leftOf = (id: number) => evaluator.$.leftOf(id) >>> 0;
  const rightOf = (id: number) => evaluator.$.rightOf(id) >>> 0;
  const symOf = (id: number) => evaluator.$.symOf(id) >>> 0;

  // Pre-order traversal: leftmost nodes first.
  const stack: number[] = [nodeId >>> 0];
  const seen = new Set<number>();
  const MAX_VISITED = 250_000;

  const isRedexAt = (root: number): boolean => {
    // Count args by walking the application spine.
    let cur = root >>> 0;
    let args = 0;
    for (;;) {
      const kind = kindOf(cur);
      if (kind !== (ArenaKind.NonTerm as number)) break;
      args++;
      cur = leftOf(cur);
    }
    if (kindOf(cur) !== (ArenaKind.Terminal as number)) return false;
    const sym = symOf(cur);
    if (sym === (ArenaSym.I as number)) return args >= 1;
    if (sym === (ArenaSym.K as number)) return args >= 2;
    if (sym === (ArenaSym.S as number)) return args >= 3;
    return false;
  };

  while (stack.length > 0) {
    const cur = stack.pop()! >>> 0;
    if (seen.has(cur)) continue;
    seen.add(cur);
    if (seen.size > MAX_VISITED) {
      // Defensive: if we ever hit pathological graphs, treat as "has redex"
      // so we don't incorrectly claim normal form.
      return true;
    }

    const kind = kindOf(cur);
    if (kind === (ArenaKind.NonTerm as number)) {
      if (isRedexAt(cur)) return true;
      // Pre-order: push right then left so left is visited first.
      stack.push(rightOf(cur));
      stack.push(leftOf(cur));
    } else {
      // Terminal/Continuation/Suspension: no redex rooted *here*.
      // Note: Continuation/Suspension can contain pointers; but for CLI forest output
      // we're only evaluating expression roots, and we don't expect these in the graph.
      continue;
    }
  }

  return false;
}

async function evaluateBatchParallel(
  evaluator: ParallelArenaEvaluatorWasm,
  sourceArenaId: number,
  maxSteps: number,
  onStep?: (stepsTaken: number) => void,
): Promise<Omit<EvalResult, "expr">> {
  const MAX_HISTORY_SIZE = 10000;
  const MAX_PATH_STEPS = 10000;

  const st = initEvalState(sourceArenaId);
  let stepsTaken = 0;

  try {
    for (let step = 0; step < maxSteps; step++) {
      if (st.done) break;
      // Each call does exactly one reduction step
      const nextId = await evaluator.reduceArenaNodeIdAsync(
        st.currentId,
        undefined,
        1,
      );
      stepsTaken++;
      onStep?.(stepsTaken);

      if (nextId === st.currentId) {
        // "No change" can mean either:
        // - true normal form (no redex)
        // - a self-reproducing redex (e.g. Ω) where the reduced result is structurally identical
        //   due to hash-consing, so the arena node id is unchanged.
        st.done = true;
        st.reachedNormalForm = !hasAnyRedex(evaluator, st.currentId);
        break;
      }
      if (st.seenIds.has(nextId)) {
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
      st.done = true;
    }
  } catch (error) {
    // Check if this is a resubmission limit error
    if (error instanceof ResubmissionLimitExceededError) {
      st.done = true;
    } else {
      st.done = true;
    }
  }

  return {
    source: st.source,
    sink: st.currentId,
    steps: st.steps,
    reachedNormalForm: st.reachedNormalForm,
    stepsTaken,
  };
}

export async function* generateEvaluationForest(
  symbolCount: number,
  maxSteps: number = 100000,
  options?: {
    workerCount?: number;
    includeLabels?: boolean;
    progress?: boolean;
  },
): AsyncGenerator<EvalResult | string, void, unknown> {
  // Use navigator.hardwareConcurrency when available, fallback to 8
  const workerCount = options?.workerCount ??
    (typeof navigator !== "undefined" &&
        typeof navigator.hardwareConcurrency === "number"
      ? navigator.hardwareConcurrency
      : 8);
  const includeLabels = options?.includeLabels ?? true;
  const progress = options?.progress ?? false;

  const logProgress = (msg: string) => {
    if (!progress) return;
    console.error(`[genForest] ${msg}`);
  };

  const startedAt = Date.now();
  const elapsedSec = () => ((Date.now() - startedAt) / 1000).toFixed(1);

  logProgress(
    `start symbolCount=${symbolCount} maxSteps=${maxSteps} workers=${workerCount} labels=${includeLabels}`,
  );
  const evaluator = await ParallelArenaEvaluatorWasm.create(workerCount);

  try {
    logProgress(`enumerating expressions (n=${symbolCount})...`);
    const allExprs = enumerateExpressions(symbolCount);
    const total = allExprs.length;
    logProgress(`enumerated ${total} expressions (elapsed ${elapsedSec()}s)`);

    // Pre-convert all expressions to arena node IDs sequentially to ensure
    // deterministic node ID assignment. This is critical for deterministic output.
    const allArenaIds: number[] = [];
    logProgress(`converting expressions to arena IDs...`);
    for (let i = 0; i < total; i++) {
      allArenaIds.push(evaluator.toArena(allExprs[i]));
    }
    logProgress(
      `converted ${total} expressions to arena IDs (elapsed ${elapsedSec()}s)`,
    );

    // Track all unique node IDs that appear in evaluation paths
    const allNodeIds = new Set<number>();

    // Configure workers to execute exactly one reduction step per submission.
    // The per-expression step limit is enforced in JS.
    // Sliding concurrency window: when one expression completes, immediately start another.
    const CONCURRENCY = workerCount;
    let nextIndex = 0;
    let processed = 0;

    type SlotState =
      | { exprIndex: number; stepsTaken: number; startedAtMs: number }
      | null;
    const slots: SlotState[] = new Array(CONCURRENCY).fill(null);

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

        const promise = base.then((result) => ({
          slot,
          exprIndex,
          result: { ...result, expr: unparseSKI(allExprs[exprIndex]) },
        }));
        inFlights.push({ slot, exprIndex, promise });
      };

      for (let slot = 0; slot < CONCURRENCY; slot++) {
        startSlot(slot);
      }

      let lastProgressAtMs = 0;
      while (inFlights.length > 0) {
        // Wait for next completion if we have in-flight work
        if (inFlights.length > 0) {
          const done = await Promise.race(
            inFlights.map((e) => e.promise),
          );
          inFlights = inFlights.filter((e) => e.slot !== done.slot);

          slots[done.slot] = null;
          processed++;
          if (progress) {
            const now = Date.now();
            if (now - lastProgressAtMs > 1000) {
              lastProgressAtMs = now;
              const stats = evaluator.getRingStatsSnapshot();
              logProgress(
                `eval ${processed}/${total} pending=${stats.pending} completed=${stats.completed} submitOk=${stats.submitOk} submitFull=${stats.submitFull} pullEmpty=${stats.pullEmpty} pullNonEmpty=${stats.pullNonEmpty} (elapsed ${elapsedSec()}s)`,
              );
            }
          }
          // Track node IDs from this result
          allNodeIds.add(done.result.source);
          allNodeIds.add(done.result.sink);
          for (const step of done.result.steps) {
            allNodeIds.add(step.from);
            allNodeIds.add(step.to);
          }

          // Always emit immediately (no head-of-line blocking).
          yield done.result;

          // backfill this slot if more work remains
          startSlot(done.slot);
        }
      }
    } finally {
      // Inner try block cleanup (if needed in future)
    }

    // Generate and stream node labels for all unique node IDs
    // Convert each node ID to its string representation
    if (includeLabels) {
      logProgress(`emitting node labels (${allNodeIds.size} ids)...`);
      for (const nodeId of allNodeIds) {
        try {
          const expr = evaluator.fromArena(nodeId);
          const label = unparseSKI(expr);
          yield JSON.stringify({ type: "nodeLabel", id: nodeId, label });
        } catch (_error) {
          // Skip nodes that can't be converted (e.g., internal WASM nodes)
          // They'll fall back to node_${nodeId} in genSvg
        }
      }
      logProgress(`done emitting node labels (elapsed ${elapsedSec()}s)`);
    }
    logProgress(`done (elapsed ${elapsedSec()}s)`);
  } finally {
    // Clean up workers
    evaluator.terminate();
  }
}

async function streamToStdout(
  symbolCount: number,
  _verbose: boolean,
  maxSteps: number = 100000,
  options?: {
    workerCount?: number;
    includeLabels?: boolean;
    progress?: boolean;
  },
) {
  const BATCH_SIZE = 100; // Batch size for stringification
  const resultBatch: EvalResult[] = [];

  for await (
    const data of generateEvaluationForest(symbolCount, maxSteps, options)
  ) {
    // Check if this is global info (string) or evaluation result (object)
    if (typeof data === "string") {
      // Global info - now always a complete JSON object
      // Flush any pending results before global info
      if (resultBatch.length > 0) {
        const batchStr = resultBatch.map((r) => JSON.stringify(r)).join("\n");
        console.log(batchStr);
        resultBatch.length = 0;
      }
      // Write the complete global info JSON object followed by a newline
      console.log(data);
    } else {
      // Evaluation result object - batch stringify
      resultBatch.push(data);
      if (resultBatch.length >= BATCH_SIZE) {
        // Stringify each object individually to avoid regex issues with nested arrays
        // This is safer than using regex replacement which can match inside nested structures
        const jsonl = resultBatch.map((r) => JSON.stringify(r)).join("\n");
        console.log(jsonl);
        resultBatch.length = 0;
      }
    }
  }

  // Flush any remaining results
  if (resultBatch.length > 0) {
    // Stringify each object individually to avoid regex issues with nested arrays
    const jsonl = resultBatch.map((r) => JSON.stringify(r)).join("\n");
    console.log(jsonl);
  }
}

async function main(): Promise<void> {
  const {
    symbolCount,
    verbose,
    maxSteps = 100000,
    workers,
    progress,
    includeLabels,
  } = parseArgs();
  await streamToStdout(symbolCount, verbose, maxSteps, {
    workerCount: workers,
    progress,
    includeLabels,
  });
}

if (import.meta.main) {
  await main();
}
