import type { SKIExpression } from "../ski/expression.ts";

export interface Evaluator {
  /** Apply exactly one β-step (or return unchanged). */
  stepOnce(expr: SKIExpression): { altered: boolean; expr: SKIExpression };

  /** Keep stepping until fix-point or maxIterations. */
  reduce(expr: SKIExpression, maxIterations?: number): SKIExpression;
}
