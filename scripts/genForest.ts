import { apply } from "../lib/ski/expression.ts";
import { I, K, S } from "../lib/ski/terminal.ts";
import type { SKIExpression } from "../lib/ski/expression.ts";
import {
  createArenaEvaluatorRelease,
  hasEmbedding,
} from "../lib/evaluator/arenaEvaluator.ts";
import type { EvaluationStep, GlobalInfo } from "./types.ts";

const memo = new Map<number, SKIExpression[]>();
const [nRaw, outputPath] = Deno.args;

if (!nRaw) {
  console.error(
    "Usage: deno run -A scripts/genForest.ts <symbolCount> [outputFile]",
  );
  console.error("");
  console.error(
    "symbolCount  Number of terminal symbols (S/K/I) in each generated expression.",
  );
  console.error(
    "outputFile   Optional output file path. If not provided, outputs to stdout.",
  );
  Deno.exit(1);
}

console.error(`Arguments: nRaw=${nRaw}, outputPath=${outputPath}`);
const n = Number.parseInt(nRaw, 10);
console.error(`Parsed n=${n}`);

if (!Number.isFinite(n) || n <= 0) {
  console.error(
    `symbolCount must be a positive integer; received \`${nRaw}\`.`,
  );
  Deno.exit(1);
}

console.error("Starting processing...");
if (outputPath) {
  await streamToFile(n, outputPath);
} else {
  await streamToStdout(n);
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

      if (hasEmbedding(evaluator.dumpArena().nodes, history, nextId)) {
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

async function streamToFile(symbolCount: number, outputPath: string) {
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

async function streamToStdout(symbolCount: number) {
  const wasmPath = "assembly/build/release.wasm";

  for await (const data of generateEvaluationForest(symbolCount, wasmPath)) {
    console.log(data);
  }
}
