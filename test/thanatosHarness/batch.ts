import type { Evaluator } from "../../lib/evaluator/evaluator.ts";
import { createArenaEvaluator } from "../../lib/index.ts";
import type { SKIExpression } from "../../lib/ski/expression.ts";
import { unparseSKI } from "../../lib/ski/expression.ts";
import { fromTopoDagWire } from "../../lib/ski/topoDagWire.ts";
import { parseSKI } from "../../lib/parser/ski.ts";
import { withBatchThanatosSession } from "./session.ts";

export const passthroughEvaluator: Evaluator = {
  stepOnce: (expr: SKIExpression) => ({ altered: false, expr }),
  reduce: (expr: SKIExpression) => expr,
  reduceAsync: (expr: SKIExpression) => Promise.resolve(expr),
};

let thanatosNormalizationEvaluatorPromise: Promise<Evaluator> | null = null;

const getThanatosNormalizationEvaluator = async (): Promise<Evaluator> => {
  if (thanatosNormalizationEvaluatorPromise === null) {
    thanatosNormalizationEvaluatorPromise = createArenaEvaluator();
  }
  return await thanatosNormalizationEvaluatorPromise;
};

export async function getThanatosDecodeEvaluator(): Promise<Evaluator> {
  return await getThanatosNormalizationEvaluator();
}

export async function normalizeThanatosExpr(
  expr: SKIExpression,
): Promise<SKIExpression> {
  const evaluator = await getThanatosNormalizationEvaluator();
  return evaluator.reduceAsync
    ? await evaluator.reduceAsync(expr)
    : evaluator.reduce(expr);
}

export async function runThanatosBatch(exprLines: string[]): Promise<string[]> {
  if (exprLines.length === 0) return [];
  return await withBatchThanatosSession(async (session) => {
    const out: string[] = [];
    for (const line of exprLines) {
      const expr = parseSKI(line);
      const resultDag = await session.reduceExpr(expr);
      const normalized = await normalizeThanatosExpr(
        fromTopoDagWire(resultDag),
      );
      out.push(unparseSKI(normalized));
    }
    return out;
  });
}
