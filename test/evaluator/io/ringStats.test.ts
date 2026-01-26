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

  const snapshot = stats.getSnapshot(5, 10);

  assertEquals(snapshot.submitOk, 2);
  assertEquals(snapshot.submitFull, 1);
  assertEquals(snapshot.submitNotConnected, 1);
  assertEquals(snapshot.pullEmpty, 1);
  assertEquals(snapshot.pullNonEmpty, 2);
  assertEquals(snapshot.completionsStashed, 1);
  assertEquals(snapshot.pending, 5);
  assertEquals(snapshot.completed, 10);
});

Deno.test("RingStats - reset", () => {
  const stats = new RingStats();

  stats.recordSubmitOk();
  stats.recordSubmitFull();
  stats.recordPullNonEmpty();

  stats.reset();

  const snapshot = stats.getSnapshot(0, 0);
  assertEquals(snapshot.submitOk, 0);
  assertEquals(snapshot.submitFull, 0);
  assertEquals(snapshot.pullNonEmpty, 0);
});
