/**
 * Evaluator interface for SKI expressions.
 *
 * This module defines the interface for SKI expression evaluators,
 * providing asynchronous observation and full reduction operations.
 *
 * @module
 */
import type { SKIExpression } from "../ski/expression.ts";

export interface Evaluator {
  /** Return an evaluator-observed next expression or normal form. */
  step(expr: SKIExpression): Promise<{ altered: boolean; expr: SKIExpression }>;

  /** Reduce to normal form. */
  reduce(expr: SKIExpression, maxIterations?: number): Promise<SKIExpression>;
}
