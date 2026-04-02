import type { Evaluator } from "../../lib/evaluator/evaluator.ts";
import type { SKIExpression } from "../../lib/ski/expression.ts";
import { unparseSKI } from "../../lib/ski/expression.ts";
import { fromDagWire, toDagWire } from "../../lib/ski/dagWire.ts";
import { parseSKI } from "../../lib/parser/ski.ts";
import { withBatchThanatosSession } from "./session.ts";

export const passthroughEvaluator: Evaluator = {
  stepOnce: (expr: SKIExpression) => ({ altered: false, expr }),
  reduce: (expr: SKIExpression) => expr,
  reduceAsync: (expr: SKIExpression) => Promise.resolve(expr),
};

export async function runThanatosBatch(exprLines: string[]): Promise<string[]> {
  if (exprLines.length === 0) return [];
  return await withBatchThanatosSession(async (session) => {
    const out: string[] = [];
    for (const line of exprLines) {
      const expr = parseSKI(line);
      const dag = toDagWire(expr);
      const resultDag = await session.reduceDag(dag);
      out.push(unparseSKI(fromDagWire(resultDag)));
    }
    return out;
  });
}
