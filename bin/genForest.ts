#!/usr/bin/env -S deno run -A

/**
 * SKI Evaluation Forest Generator
 *
 * Generates evaluation forests for SKI expressions with a given number of symbols.
 * Outputs JSONL format with evaluation paths and global arena information.
 */

import { unparseSKI } from "../lib/ski/expression.ts";
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
    const parsed = Number.parseInt(maxStepsValue!, 10);
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
    const parsed = Number.parseInt(workersValue!, 10);
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

  const symbolCount = Number.parseInt(nonFlagArgs[0]!, 10);

  if (!Number.isFinite(symbolCount) || symbolCount <= 0) {
    console.error(
      `Error: symbolCount must be a positive integer; received '${nonFlagArgs[
        0
      ]!}'`,
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

async function evaluateParallel(
  evaluator: ParallelArenaEvaluatorWasm,
  initialId: number,
  maxSteps: number,
): Promise<Omit<EvalResult, "expr">> {
  let finalId = initialId;

  try {
    finalId = await evaluator.reduceArenaNodeIdAsync(
      initialId,
      undefined,
      maxSteps,
    );
  } catch (err) {
    if (!(err instanceof ResubmissionLimitExceededError)) {
      throw err;
    }
  }

  // Note: we don't track intermediate steps in this high-performance mode
  return {
    source: initialId,
    sink: finalId,
    steps: [],
    reachedNormalForm: finalId === initialId ? false : true, // Simplified
    stepsTaken: maxSteps, // Placeholder
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
  const workerCount = options?.workerCount ?? 8;
  const includeLabels = options?.includeLabels ?? true;
  const progress = options?.progress ?? false;

  const logProgress = (msg: string) => {
    if (!progress) return;
    console.error(`[genForest] ${msg}`);
  };

  const startedAt = Date.now();
  const elapsedSec = () => ((Date.now() - startedAt) / 1000).toFixed(1);

  logProgress(
    `start symbolCount=${symbolCount} maxSteps=${maxSteps} workers=${workerCount}`,
  );
  const evaluator = await ParallelArenaEvaluatorWasm.create(workerCount);

  try {
    logProgress(`enumerating expressions (n=${symbolCount})...`);
    const allExprs = enumerateExpressions(symbolCount);
    const total = allExprs.length;
    logProgress(`enumerated ${total} expressions (elapsed ${elapsedSec()}s)`);

    const allArenaIds: number[] = [];
    logProgress(`converting expressions to arena IDs...`);
    for (let i = 0; i < total; i++) {
      allArenaIds.push(evaluator.toArena(allExprs[i]!));
    }

    const allNodeIds = new Set<number>();
    const CONCURRENCY = workerCount;
    let processed = 0;

    // Concurrency loop using a promise pool
    const results: EvalResult[] = [];
    const pool = new Set<Promise<void>>();

    for (let i = 0; i < total; i++) {
      const exprIndex = i;
      const promise = (async () => {
        const res = await evaluateParallel(
          evaluator,
          allArenaIds[exprIndex]!,
          maxSteps,
        );
        const finalRes = { ...res, expr: unparseSKI(allExprs[exprIndex]!) };
        results.push(finalRes);
        allNodeIds.add(res.source);
        allNodeIds.add(res.sink);
        processed++;
        if (progress && processed % 100 === 0) {
          logProgress(`eval ${processed}/${total} (elapsed ${elapsedSec()}s)`);
        }
      })();
      pool.add(promise);
      promise.then(() => pool.delete(promise));
      if (pool.size >= CONCURRENCY) {
        await Promise.race(pool);
      }
    }
    await Promise.all(pool);

    for (const r of results) {
      yield r;
    }

    if (includeLabels) {
      logProgress(`emitting node labels (${allNodeIds.size} ids)...`);
      for (const nodeId of allNodeIds) {
        try {
          const expr = evaluator.fromArena(nodeId);
          const label = unparseSKI(expr);
          yield JSON.stringify({ type: "nodeLabel", id: nodeId, label });
        } catch { /* skip */ }
      }
    }
  } finally {
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
  for await (
    const data of generateEvaluationForest(symbolCount, maxSteps, options)
  ) {
    console.log(typeof data === "string" ? data : JSON.stringify(data));
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
