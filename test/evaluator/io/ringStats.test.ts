/**
 * Unit tests for RingStats component.
 *
 * @module
 */

import { assertEquals } from "std/assert";
import { RingStats } from "../../../lib/evaluator/io/ringStats.ts";

Deno.test("RingStats - statistics recording", () => {
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
  };
  const snapshot = stats.getSnapshot(5, 10, extra);

  assertEquals(snapshot.submitOk, 2);
  assertEquals(snapshot.submitFull, 1);
  assertEquals(snapshot.submitNotConnected, 1);
  assertEquals(snapshot.pullEmpty, 1);
  assertEquals(snapshot.pullNonEmpty, 2);
  assertEquals(snapshot.completionsStashed, 1);
  assertEquals(snapshot.pending, 5);
  assertEquals(snapshot.completed, 10);
  assertEquals(snapshot.totalNodes, 100);
  assertEquals(snapshot.totalSteps, 200);
  assertEquals(snapshot.hashconsHits, 30);
});

Deno.test("RingStats - reset", () => {
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
  };
  const snapshot = stats.getSnapshot(0, 0, extra);
  assertEquals(snapshot.submitOk, 0);
  assertEquals(snapshot.submitFull, 0);
  assertEquals(snapshot.pullNonEmpty, 0);
});
