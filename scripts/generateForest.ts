import { cons } from "../lib/cons.ts";
import { I, K, S } from "../lib/ski/terminal.ts";
import type { SKIExpression } from "../lib/ski/expression.ts";
import { initArenaEvaluator } from "../lib/evaluator/arenaEvaluator.ts";
import { prettyPrint } from "../lib/ski/expression.ts";
import type { EvaluationStep, GlobalInfo } from "./types.ts";

const memo = new Map<number, SKIExpression[]>();
const [nRaw, outputPath] = Deno.args;

if (!nRaw) {
  console.error(
    "Usage: deno run -A scripts/generateforest.ts <symbolCount> [outputFile]",
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
          result.push(cons(leftExpr, rightExpr));
        }
      }
    }
  }

  memo.set(leaves, result);
  return result;
}

async function generateLabel(expr: SKIExpression): Promise<string> {
  let label = prettyPrint(expr);
  if (label.length > 100) {
    const encoder = new TextEncoder();
    const data = encoder.encode(label);
    const hashBuffer = await crypto.subtle.digest("SHA-256", data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashHex = hashArray.map((b) => b.toString(16).padStart(2, "0")).join(
      "",
    );
    label = `HASH:${hashHex.substring(0, 16)}`;
  }
  return label;
}

export async function* generateEvaluationForest(
  symbolCount: number,
  wasmPath: string,
): AsyncGenerator<string, void, unknown> {
  const evaluator = await initArenaEvaluator(wasmPath);
  const allExprs = enumerateExpressions(symbolCount);
  const total = allExprs.length;
  let count = 0;
  const start = Date.now();

  console.error(
    `Processing ${total} expressions with ${symbolCount} symbols each...`,
  );
  const labels: Record<number, string> = {};
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

    let cur = expr;
    let steps = 0;
    const MAX_STEPS = 10000;
    const curId = evaluator.toArena(cur);
    const label = await generateLabel(expr);

    labels[curId] = label;
    sources.add(curId);

    const encounteredNodes = new Set<number>();
    encounteredNodes.add(curId);
    const pathSteps: EvaluationStep[] = [];

    while (steps < MAX_STEPS) {
      steps++;
      const { altered, expr: next } = evaluator.stepOnce(cur);
      if (!altered) break;

      const currentId = evaluator.toArena(cur);
      const nextId = evaluator.toArena(next);

      if (!labels[currentId]) {
        labels[currentId] = await generateLabel(cur);
      }
      if (!labels[nextId]) {
        labels[nextId] = await generateLabel(next);
      }

      if (encounteredNodes.has(nextId)) {
        pathSteps.push({ from: currentId, to: nextId });
        pathSteps.push({ from: nextId, to: nextId });
        break;
      }

      pathSteps.push({ from: currentId, to: nextId });
      encounteredNodes.add(nextId);
      cur = next;
    }

    if (steps === MAX_STEPS) {
      console.error(
        `Warning: reduction for term #${count} hit step limit (${MAX_STEPS}): ${
          prettyPrint(expr)
        }`,
      );
    }

    const finalId = evaluator.toArena(cur);
    labels[finalId] = await generateLabel(cur);
    sinks.add(finalId);

    yield JSON.stringify({
      source: curId,
      sink: finalId,
      steps: pathSteps,
    });
  }

  const { nodes } = evaluator.dumpArena();

  console.error(`Arena contains ${nodes.length} nodes`);

  for (const node of nodes) {
    if (!labels[node.id]) {
      const expr = evaluator.fromArena(node.id);
      labels[node.id] = await generateLabel(expr);
    }
  }

  const globalInfo: GlobalInfo = {
    type: "global",
    nodes,
    labels,
    sources: Array.from(sources),
    sinks: Array.from(sinks),
  };

  yield JSON.stringify(globalInfo);
}

async function streamToFile(symbolCount: number, outputPath: string) {
  const wasmPath = "assembly/build/debug.wasm";
  const file = await Deno.open(outputPath, {
    write: true,
    create: true,
    truncate: true,
  });
  const encoder = new TextEncoder();

  try {
    for await (const data of generateEvaluationForest(symbolCount, wasmPath)) {
      await file.write(encoder.encode(data + "\n"));
    }
    console.error(`Successfully wrote evaluation forest to ${outputPath}`);
  } finally {
    file.close();
  }
}

async function streamToStdout(symbolCount: number) {
  const wasmPath = "assembly/build/debug.wasm";

  for await (const data of generateEvaluationForest(symbolCount, wasmPath)) {
    console.log(data);
  }
}
