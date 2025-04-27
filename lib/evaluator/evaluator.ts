export interface Evaluator<E> {
  /** Apply exactly one β-step (or return unchanged). */
  stepOnce(expr: E): { altered: boolean; expr: E };

  /** Keep stepping until fix-point or maxIterations. */
  reduce(expr: E, maxIterations?: number): E;
}
