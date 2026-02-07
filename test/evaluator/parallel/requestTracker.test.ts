/**
 * Unit tests for RequestTracker component.
 *
 * @module
 */

import { assertEquals, assertThrows } from "std/assert";
import {
  RequestTracker,
  ResubmissionLimitExceededError,
} from "../../../lib/evaluator/parallel/requestTracker.ts";
import { I, S } from "../../../lib/ski/terminal.ts";

Deno.test("RequestTracker - request creation and assignment", () => {
  const tracker = new RequestTracker();

  const reqId1 = tracker.createRequest(3, I);
  const reqId2 = tracker.createRequest(3, S);
  const reqId3 = tracker.createRequest(3);

  assertEquals(reqId1, 1);
  assertEquals(reqId2, 2);
  assertEquals(reqId3, 3);

  // Worker assignment should be round-robin
  assertEquals(tracker.getWorkerIndex(reqId1), 0);
  assertEquals(tracker.getWorkerIndex(reqId2), 1);
  assertEquals(tracker.getWorkerIndex(reqId3), 2);

  // Next request should wrap around
  const reqId4 = tracker.createRequest(3);
  assertEquals(tracker.getWorkerIndex(reqId4), 0);
});

Deno.test("RequestTracker - expression tracking", () => {
  const tracker = new RequestTracker();

  const reqId = tracker.createRequest(1, I);
  assertEquals(tracker.getExpression(reqId), I);

  const reqId2 = tracker.createRequest(1);
  assertEquals(tracker.getExpression(reqId2), undefined);
});

Deno.test("RequestTracker - pending and completed tracking", async () => {
  const tracker = new RequestTracker();

  const reqId = tracker.createRequest(1);

  let resolvedValue: number | null = null;
  const promise = new Promise<number>((resolve) => {
    tracker.markPending(reqId, (val) => {
      resolvedValue = val;
      resolve(val);
    }, () => {});
  });

  assertEquals(tracker.isPending(reqId), true);
  assertEquals(tracker.getTotalPending(), 1);
  assertEquals(tracker.getTotalCompleted(), 0);

  tracker.markCompleted(reqId, 42);

  await promise;
  assertEquals(resolvedValue, 42);
  assertEquals(tracker.isPending(reqId), false);
  assertEquals(tracker.getTotalPending(), 0);
  assertEquals(tracker.getTotalCompleted(), 1);
});

Deno.test("RequestTracker - stashed completions", () => {
  const tracker = new RequestTracker();

  const reqId = tracker.createRequest(1);

  // Complete before pending (race condition)
  tracker.markCompleted(reqId, 99);
  assertEquals(tracker.getTotalCompleted(), 1);

  // Should be stashed
  const stashed = tracker.getStashedCompletion(reqId);
  assertEquals(stashed, 99);

  // Now mark pending - should resolve immediately
  let resolvedValue: number | null = null;
  tracker.markPending(reqId, (val) => {
    resolvedValue = val;
  }, () => {});

  assertEquals(resolvedValue, 99);
  // Completion count tracks completion events, not stash-map size.
  assertEquals(tracker.getTotalCompleted(), 1);
});

Deno.test("RequestTracker - resubmission counting", () => {
  const tracker = new RequestTracker({}, 5); // max 5 resubmits

  const reqId = tracker.createRequest(1);

  assertEquals(tracker.incrementResubmit(reqId), 1);
  assertEquals(tracker.incrementResubmit(reqId), 2);
  assertEquals(tracker.incrementResubmit(reqId), 3);
  assertEquals(tracker.incrementResubmit(reqId), 4);
  assertEquals(tracker.incrementResubmit(reqId), 5);

  // Should throw on 6th resubmit
  assertThrows(
    () => tracker.incrementResubmit(reqId),
    ResubmissionLimitExceededError,
    "Request 1 exceeded maximum resubmissions (5)",
  );
});

Deno.test("RequestTracker - abort all", () => {
  const tracker = new RequestTracker();

  const reqId1 = tracker.createRequest(1);
  const reqId2 = tracker.createRequest(1);

  let rejected1 = false;
  let rejected2 = false;

  tracker.markPending(reqId1, () => {}, () => {
    rejected1 = true;
  });
  tracker.markPending(reqId2, () => {}, () => {
    rejected2 = true;
  });

  const error = new Error("Test abort");
  tracker.abortAll(error);

  assertEquals(rejected1, true);
  assertEquals(rejected2, true);
  assertEquals(tracker.getTotalPending(), 0);
});

Deno.test("RequestTracker - completed counter tracks successful completions only", () => {
  const tracker = new RequestTracker();

  const reqId1 = tracker.createRequest(1);
  const reqId2 = tracker.createRequest(1);

  tracker.markPending(reqId1, () => {}, () => {});
  tracker.markPending(reqId2, () => {}, () => {});

  tracker.markCompleted(reqId1, 1);
  assertEquals(tracker.getTotalCompleted(), 1);

  tracker.markError(reqId2, new Error("boom"));
  // Errors should not increase the completion counter.
  assertEquals(tracker.getTotalCompleted(), 1);
});

Deno.test("RequestTracker - pending counts per worker", () => {
  const tracker = new RequestTracker();

  // Create requests for 3 workers
  const reqId1 = tracker.createRequest(3); // worker 0
  const reqId2 = tracker.createRequest(3); // worker 1
  const reqId3 = tracker.createRequest(3); // worker 2

  tracker.markPending(reqId1, () => {}, () => {});
  tracker.markPending(reqId2, () => {}, () => {});
  tracker.markPending(reqId3, () => {}, () => {});

  const counts = tracker.getPendingCounts();
  assertEquals(counts.length, 3);
  assertEquals(counts[0], 1);
  assertEquals(counts[1], 1);
  assertEquals(counts[2], 1);

  tracker.markCompleted(reqId1, 1);

  const countsAfter = tracker.getPendingCounts();
  assertEquals(countsAfter[0], 0);
  assertEquals(countsAfter[1], 1);
  assertEquals(countsAfter[2], 1);
});

Deno.test("RequestTracker - instrumentation hooks", () => {
  let queuedCalled = false;
  let completedCalled = false;
  let errorCalled = false;
  let yieldCalled = false;

  const hooks = {
    onRequestQueued: () => {
      queuedCalled = true;
    },
    onRequestCompleted: () => {
      completedCalled = true;
    },
    onRequestError: () => {
      errorCalled = true;
    },
    onRequestYield: () => {
      yieldCalled = true;
    },
  };

  const tracker = new RequestTracker(hooks);
  const reqId = tracker.createRequest(1, I);

  tracker.markPending(reqId, () => {}, () => {});
  assertEquals(queuedCalled, true);

  tracker.markCompleted(reqId, 1);
  assertEquals(completedCalled, true);

  const reqId2 = tracker.createRequest(1);
  tracker.markPending(reqId2, () => {}, () => {});
  tracker.incrementResubmit(reqId2);
  tracker.recordYield(reqId2, 100, 1);
  assertEquals(yieldCalled, true);

  tracker.markError(reqId2, new Error("test"));
  assertEquals(errorCalled, true);
});
