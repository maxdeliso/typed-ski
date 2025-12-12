#!/usr/bin/env -S deno run --allow-read --allow-write --allow-run

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
  createArenaEvaluatorRelease,
} from "../lib/evaluator/arenaEvaluator.ts";
import type { EvaluationStep, GlobalInfo } from "../lib/shared/forestTypes.ts";

import { VERSION } from "../lib/shared/version.ts";

// Memoization for expression enumeration
const memo = new Map<number, SKIExpression[]>();

interface CLIArgs {
  symbolCount: number;
  outputFile?: string;
  verbose: boolean;
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

  const outputFile = nonFlagArgs[1];

  return { symbolCount, outputFile, verbose };
}

function printHelp(): void {
  console.log(`SKI Evaluation Forest Generator v${VERSION}

USAGE:
    genForest <symbolCount> [outputFile] [options]

ARGUMENTS:
    symbolCount    Number of terminal symbols (S/K/I) in each generated expression
    outputFile     Optional output file path. If not provided, outputs to stdout

OPTIONS:
    --verbose, -v  Enable verbose output
    --help, -h     Show this help message
    --version      Show version information

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

export async function* generateEvaluationForest(
  symbolCount: number,
): AsyncGenerator<string, void, unknown> {
  const evaluator = await createArenaEvaluatorRelease();
  const allExprs = enumerateExpressions(symbolCount);
  const total = allExprs.length;
  let count = 0;
  const start = Date.now();

  console.error(
    `Processing ${total} expressions with ${symbolCount} symbols each...`,
  );
  const sources = new Set<number>();
  const sinks = new Set<number>();

  for (const expr of allExprs) {
    count++;
    if (count % 1000 === 0 || count === total) {
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      console.error(
        `Processed ${count} / ${total} (${
          ((count / total) * 100).toFixed(2)
        }%) in ${elapsed}s`,
      );
    }

    const curId = evaluator.toArena(expr);
    sources.add(curId);

    // Track evaluation history for cycle detection
    const history: number[] = [curId];
    const pathSteps: EvaluationStep[] = [];
    let hasCycle = false;
    let currentId = curId;

    // Manual evaluation with cycle detection
    for (let step = 0;; step++) {
      const { altered, expr: nextExpr } = evaluator.stepOnce(
        evaluator.fromArena(currentId),
      );

      if (!altered) {
        break; // No more reduction possible
      }

      const nextId = evaluator.toArena(nextExpr);

      if (evaluator.hasEmbedding(history, nextId)) {
        hasCycle = true;
        break;
      }

      pathSteps.push({ from: currentId, to: nextId });
      currentId = nextId;
      history.push(currentId);
    }

    const finalId = currentId;
    sinks.add(finalId);

    yield JSON.stringify({
      source: curId,
      sink: finalId,
      steps: pathSteps,
      hasCycle,
    });
  }

  const { nodes } = evaluator.dumpArena();

  console.error(`Arena contains ${nodes.length} nodes`);

  const globalInfo: GlobalInfo = {
    type: "global",
    nodes,
    sources: Array.from(sources),
    sinks: Array.from(sinks),
  };

  yield JSON.stringify(globalInfo);
}

async function streamToFile(
  symbolCount: number,
  outputPath: string,
  verbose: boolean,
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
    for await (const data of generateEvaluationForest(symbolCount)) {
      await file.write(encoder.encode(data + "\n"));
    }
    console.error(`Successfully wrote evaluation forest to ${outputPath}`);
  } finally {
    file.close();
  }
}

async function streamToStdout(symbolCount: number, verbose: boolean) {
  if (verbose) {
    console.error("Writing output to stdout...");
  }

  for await (const data of generateEvaluationForest(symbolCount)) {
    console.log(data);
  }
}

async function main(): Promise<void> {
  const { symbolCount, outputFile, verbose } = parseArgs();

  if (verbose) {
    console.error(
      `Arguments: symbolCount=${symbolCount}, outputFile=${
        outputFile || "stdout"
      }`,
    );
  }

  console.error("Starting processing...");

  if (outputFile) {
    await streamToFile(symbolCount, outputFile, verbose);
  } else {
    await streamToStdout(symbolCount, verbose);
  }
}

if (import.meta.main) {
  await main();
}
