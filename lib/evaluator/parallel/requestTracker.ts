/**
 * Request lifecycle management for parallel evaluation.
 *
 * Tracks pending/completed requests, worker assignments, resubmissions,
 * and provides instrumentation hooks.
 *
 * @module
 */

import type { SKIExpression } from "../../ski/expression.ts";

/**
 * Error thrown when a work unit exceeds the maximum number of resubmissions.
 * This typically indicates that the expression does not normalize (diverges).
 */
export class ResubmissionLimitExceededError extends Error {
  constructor(
    public readonly reqId: number,
    public readonly resubmitCount: number,
    public readonly maxResubmits: number,
  ) {
    super(
      `Request ${reqId} exceeded maximum resubmissions (${maxResubmits}). This expression likely does not normalize.`,
    );
    this.name = "ResubmissionLimitExceededError";
  }
}

type RequestResolver = {
  resolve: (val: number) => void;
  reject: (err: Error) => void;
};

/**
 * Optional instrumentation hooks (used by `server/workbench.js`).
 *
 * Notes:
 * - `workerIndex` is a logical assignment (round-robin at submit time).
 *   CQ completions don't encode the physical worker thread id.
 */
export interface RequestTrackerHooks {
  onRequestQueued?: (
    reqId: number,
    workerIndex: number,
    expr?: SKIExpression,
  ) => void;
  onRequestCompleted?: (
    reqId: number,
    workerIndex: number,
    expr: SKIExpression | undefined,
    arenaNodeId: number,
  ) => void;
  onRequestError?: (
    reqId: number,
    workerIndex: number,
    expr: SKIExpression | undefined,
    error: string,
  ) => void;
  onRequestYield?: (
    reqId: number,
    workerIndex: number,
    expr: SKIExpression | undefined,
    suspensionNodeId: number,
    resubmitCount: number,
  ) => void;
}

/**
 * Manages request lifecycle for parallel evaluation.
 */
export class RequestTracker {
  private nextRequestId = 1;
  private readonly pending = new Map<number, RequestResolver>();
  private readonly completed = new Map<number, number>();
  private nextWorkerIndex = 0;
  private readonly reqToWorkerIndex = new Map<number, number>();
  private readonly reqToExpr = new Map<number, SKIExpression>();
  private readonly reqToResubmitCount = new Map<number, number>();
  private readonly workerPendingCounts: number[] = [];
  private readonly hooks: RequestTrackerHooks;
  private readonly maxResubmits: number;

  constructor(
    hooks: RequestTrackerHooks = {},
    maxResubmits: number = 10,
  ) {
    this.hooks = hooks;
    this.maxResubmits = maxResubmits;
  }

  /**
   * Creates a new request and assigns it to a worker.
   * Returns the request ID.
   */
  createRequest(
    nWorkers: number,
    expr?: SKIExpression,
  ): number {
    const reqId = this.nextRequestId++ >>> 0;

    // Track logical worker slot for UI (round-robin assignment).
    if (this.workerPendingCounts.length !== nWorkers) {
      this.workerPendingCounts.length = 0;
      this.workerPendingCounts.push(...new Array(nWorkers).fill(0));
    }
    const workerIndex = this.nextWorkerIndex++ % nWorkers;
    this.reqToWorkerIndex.set(reqId, workerIndex);
    if (expr) this.reqToExpr.set(reqId, expr);
    this.workerPendingCounts[workerIndex] =
      (this.workerPendingCounts[workerIndex] ?? 0) + 1;

    return reqId;
  }

  /**
   * Gets the worker index assigned to a request.
   */
  getWorkerIndex(reqId: number): number {
    return this.reqToWorkerIndex.get(reqId) ?? 0;
  }

  /**
   * Gets the expression associated with a request.
   */
  getExpression(reqId: number): SKIExpression | undefined {
    return this.reqToExpr.get(reqId);
  }

  /**
   * Registers a pending request with its promise resolvers.
   */
  markPending(
    reqId: number,
    resolve: (val: number) => void,
    reject: (err: Error) => void,
  ): void {
    // Check if already completed (race condition handling)
    const existing = this.completed.get(reqId);
    if (existing !== undefined) {
      this.completed.delete(reqId);
      resolve(existing);
      return;
    }

    this.pending.set(reqId, { resolve, reject });
    const workerIndex = this.getWorkerIndex(reqId);
    const expr = this.getExpression(reqId);
    this.hooks.onRequestQueued?.(reqId, workerIndex, expr);
  }

  /**
   * Marks a request as completed with the result node ID.
   */
  markCompleted(reqId: number, nodeId: number): void {
    const resolver = this.pending.get(reqId);
    if (resolver) {
      this.pending.delete(reqId);
      const workerIndex = this.getWorkerIndex(reqId);
      const expr = this.getExpression(reqId);
      this.decrementWorkerPending(workerIndex);
      this.cleanupRequest(reqId);
      this.hooks.onRequestCompleted?.(reqId, workerIndex, expr, nodeId);
      resolver.resolve(nodeId);
    } else {
      // Completion can race with registration, or belong to a caller that already
      // gave up. Stash it so a future awaiter can still observe it.
      this.completed.set(reqId, nodeId);
    }
  }

  /**
   * Marks a request as failed with an error.
   */
  markError(reqId: number, error: Error): void {
    const resolver = this.pending.get(reqId);
    if (resolver) {
      this.pending.delete(reqId);
      const workerIndex = this.getWorkerIndex(reqId);
      const expr = this.getExpression(reqId);
      this.decrementWorkerPending(workerIndex);
      this.cleanupRequest(reqId);
      this.hooks.onRequestError?.(
        reqId,
        workerIndex,
        expr,
        error.message,
      );
      resolver.reject(error);
    }
  }

  /**
   * Checks if a request is still pending.
   */
  isPending(reqId: number): boolean {
    return this.pending.has(reqId);
  }

  /**
   * Gets a stashed completion if available.
   */
  getStashedCompletion(reqId: number): number | undefined {
    return this.completed.get(reqId);
  }

  /**
   * Increments the resubmission count for a request and checks if limit exceeded.
   * Returns the new resubmit count, or throws if limit exceeded.
   */
  incrementResubmit(reqId: number): number {
    const resubmitCount = (this.reqToResubmitCount.get(reqId) ?? 0) + 1;
    if (resubmitCount > this.maxResubmits) {
      const workerIndex = this.getWorkerIndex(reqId);
      const expr = this.getExpression(reqId);
      const error = new ResubmissionLimitExceededError(
        reqId,
        resubmitCount,
        this.maxResubmits,
      );
      this.hooks.onRequestError?.(
        reqId,
        workerIndex,
        expr,
        error.message,
      );
      throw error;
    }
    this.reqToResubmitCount.set(reqId, resubmitCount);
    return resubmitCount;
  }

  /**
   * Records a yield event for instrumentation.
   */
  recordYield(
    reqId: number,
    suspensionNodeId: number,
    resubmitCount: number,
  ): void {
    const workerIndex = this.getWorkerIndex(reqId);
    const expr = this.getExpression(reqId);
    this.hooks.onRequestYield?.(
      reqId,
      workerIndex,
      expr,
      suspensionNodeId,
      resubmitCount,
    );
  }

  /**
   * Aborts all pending requests with the given error.
   */
  abortAll(error: Error): void {
    for (const { reject } of this.pending.values()) {
      reject(error);
    }
    this.pending.clear();
    this.completed.clear();
    this.reqToWorkerIndex.clear();
    this.reqToExpr.clear();
    this.reqToResubmitCount.clear();
    this.workerPendingCounts.fill(0);
  }

  /**
   * Returns per-worker pending counts (best-effort logical assignment).
   */
  getPendingCounts(): number[] {
    return this.workerPendingCounts.slice();
  }

  /**
   * Returns the total number of pending requests.
   */
  getTotalPending(): number {
    return this.pending.size;
  }

  /**
   * Returns the total number of completed requests.
   */
  getTotalCompleted(): number {
    return this.completed.size;
  }

  private decrementWorkerPending(workerIndex: number): void {
    if (workerIndex < this.workerPendingCounts.length) {
      this.workerPendingCounts[workerIndex] = Math.max(
        0,
        (this.workerPendingCounts[workerIndex] ?? 0) - 1,
      );
    }
  }

  private cleanupRequest(reqId: number): void {
    this.reqToWorkerIndex.delete(reqId);
    this.reqToExpr.delete(reqId);
    this.reqToResubmitCount.delete(reqId);
  }
}
