/**
 * Unit tests for RingStats component.
 *
 * @module
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { RingStats } from "../../../lib/evaluator/io/ringStats.ts";

test("RingStats - statistics recording", () => {
  const stats = new RingStats();

  stats.recordSubmitOk();
  stats.recordSubmitOk();
  stats.recordSubmitFull();
  stats.recordSubmitNotConnected();
  stats.recordPullEmpty();
  stats.recordPullNonEmpty();
  stats.recordPullNonEmpty();
  stats.recordCompletionStashed();

  const extra = {
    totalNodes: 100,
    totalSteps: 200,
    totalConsAllocs: 50,
    totalContAllocs: 10,
    totalSuspAllocs: 5,
    duplicateLostAllocs: 2,
    hashconsHits: 30,
    hashconsMisses: 20,
    totalLinkChaseHops: 0,
  };
  const snapshot = stats.getSnapshot(5, 10, extra);

  assert.strictEqual(snapshot.submitOk, 2);
  assert.strictEqual(snapshot.submitFull, 1);
  assert.strictEqual(snapshot.submitNotConnected, 1);
  assert.strictEqual(snapshot.pullEmpty, 1);
  assert.strictEqual(snapshot.pullNonEmpty, 2);
  assert.strictEqual(snapshot.completionsStashed, 1);
  assert.strictEqual(snapshot.pending, 5);
  assert.strictEqual(snapshot.completed, 10);
  assert.strictEqual(snapshot.totalNodes, 100);
  assert.strictEqual(snapshot.totalSteps, 200);
  assert.strictEqual(snapshot.hashconsHits, 30);
});

test("RingStats - reset", () => {
  const stats = new RingStats();

  stats.recordSubmitOk();
  stats.recordSubmitFull();
  stats.recordPullNonEmpty();

  stats.reset();

  const extra = {
    totalNodes: 0,
    totalSteps: 0,
    totalConsAllocs: 0,
    totalContAllocs: 0,
    totalSuspAllocs: 0,
    duplicateLostAllocs: 0,
    hashconsHits: 0,
    hashconsMisses: 0,
    totalLinkChaseHops: 0,
  };
  const snapshot = stats.getSnapshot(0, 0, extra);
  assert.strictEqual(snapshot.submitOk, 0);
  assert.strictEqual(snapshot.submitFull, 0);
  assert.strictEqual(snapshot.pullNonEmpty, 0);
});
