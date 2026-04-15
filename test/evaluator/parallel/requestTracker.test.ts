/**
 * Unit tests for RequestTracker component.
 *
 * @module
 */

import { describe, it } from "../../util/test_shim.ts";
import assert from "node:assert/strict";
import {
  RequestTracker,
  ResubmissionLimitExceededError,
} from "../../../lib/evaluator/parallel/requestTracker.ts";
import { I, S } from "../../../lib/ski/terminal.ts";

it("RequestTracker - request creation and assignment", () => {
  const tracker = new RequestTracker();

  const reqId1 = tracker.createRequest(3, I);
  const reqId2 = tracker.createRequest(3, S);
  const reqId3 = tracker.createRequest(3);

  assert.strictEqual(reqId1, 1);
  assert.strictEqual(reqId2, 2);
  assert.strictEqual(reqId3, 3);

  // Worker assignment should be round-robin
  assert.strictEqual(tracker.getWorkerIndex(reqId1), 0);
  assert.strictEqual(tracker.getWorkerIndex(reqId2), 1);
  assert.strictEqual(tracker.getWorkerIndex(reqId3), 2);

  // Next request should wrap around
  const reqId4 = tracker.createRequest(3);
  assert.strictEqual(tracker.getWorkerIndex(reqId4), 0);
});

it("RequestTracker - validates maxResubmits constructor option", () => {
  assert.throws(() => new RequestTracker({}, -1), {
    name: "Error",
    message: /^maxResubmits must be an integer >= 0, got -1$/,
  });
  assert.throws(() => new RequestTracker({}, 1.5), {
    name: "Error",
    message: /^maxResubmits must be an integer >= 0, got 1.5$/,
  });
});

it("RequestTracker - expression tracking", () => {
  const tracker = new RequestTracker();

  const reqId = tracker.createRequest(1, I);
  assert.strictEqual(tracker.getExpression(reqId), I);

  const reqId2 = tracker.createRequest(1);
  assert.strictEqual(tracker.getExpression(reqId2), undefined);
});

it("RequestTracker - pending and completed tracking", async () => {
  const tracker = new RequestTracker();

  const reqId = tracker.createRequest(1);

  let resolvedValue: number | null = null;
  const promise = new Promise<number>((resolve) => {
    tracker.markPending(
      reqId,
      (val) => {
        resolvedValue = val;
        resolve(val);
      },
      () => {},
    );
  });

  assert.strictEqual(tracker.isPending(reqId), true);
  assert.strictEqual(tracker.getTotalPending(), 1);
  assert.strictEqual(tracker.getTotalCompleted(), 0);

  tracker.markCompleted(reqId, 42);

  await promise;
  assert.strictEqual(resolvedValue, 42);
  assert.strictEqual(tracker.isPending(reqId), false);
  assert.strictEqual(tracker.getTotalPending(), 0);
  assert.strictEqual(tracker.getTotalCompleted(), 1);
});

it("RequestTracker - stashed completions", () => {
  const tracker = new RequestTracker();

  const reqId = tracker.createRequest(1);

  // Complete before pending (race condition)
  tracker.markCompleted(reqId, 99);
  assert.strictEqual(tracker.getTotalCompleted(), 1);

  // Should be stashed
  const stashed = tracker.getStashedCompletion(reqId);
  assert.strictEqual(stashed, 99);

  // Now mark pending - should resolve immediately
  let resolvedValue: number | null = null;
  tracker.markPending(
    reqId,
    (val) => {
      resolvedValue = val;
    },
    () => {},
  );

  assert.strictEqual(resolvedValue, 99);
  // Completion count tracks completion events, not stash-map size.
  assert.strictEqual(tracker.getTotalCompleted(), 1);
});

it("RequestTracker - resubmission counting", () => {
  const tracker = new RequestTracker({}, 5); // max 5 resubmits

  const reqId = tracker.createRequest(1);

  assert.strictEqual(tracker.incrementResubmit(reqId), 1);
  assert.strictEqual(tracker.incrementResubmit(reqId), 2);
  assert.strictEqual(tracker.incrementResubmit(reqId), 3);
  assert.strictEqual(tracker.incrementResubmit(reqId), 4);
  assert.strictEqual(tracker.incrementResubmit(reqId), 5);

  // Should throw on 6th resubmit
  assert.throws(
    () => tracker.incrementResubmit(reqId),
    ResubmissionLimitExceededError,
  );
});

it("RequestTracker - resubmission cap can be disabled", () => {
  const tracker = new RequestTracker({}, 0); // unlimited
  const reqId = tracker.createRequest(1);

  for (let i = 1; i <= 20_000; i++) {
    assert.strictEqual(tracker.incrementResubmit(reqId), i);
  }
});

it("RequestTracker - resubmission limit does not emit duplicate error hook", () => {
  let errorHookCalls = 0;
  const tracker = new RequestTracker(
    {
      onRequestError: () => {
        errorHookCalls++;
      },
    },
    1,
  );
  const reqId = tracker.createRequest(1);
  tracker.markPending(
    reqId,
    () => {},
    () => {},
  );

  assert.strictEqual(tracker.incrementResubmit(reqId), 1);
  assert.throws(
    () => tracker.incrementResubmit(reqId),
    ResubmissionLimitExceededError,
  );
  // incrementResubmit should throw only; markError owns hook emission.
  assert.strictEqual(errorHookCalls, 0);

  tracker.markError(reqId, new Error("resubmission limit exceeded"));
  assert.strictEqual(errorHookCalls, 1);
});

it("RequestTracker - abort all", () => {
  const tracker = new RequestTracker();

  const reqId1 = tracker.createRequest(1);
  const reqId2 = tracker.createRequest(1);

  let rejected1 = false;
  let rejected2 = false;

  tracker.markPending(
    reqId1,
    () => {},
    () => {
      rejected1 = true;
    },
  );
  tracker.markPending(
    reqId2,
    () => {},
    () => {
      rejected2 = true;
    },
  );

  const error = new Error("Test abort");
  tracker.abortAll(error);

  assert.strictEqual(rejected1, true);
  assert.strictEqual(rejected2, true);
  assert.strictEqual(tracker.getTotalPending(), 0);
});

it("RequestTracker - completed counter tracks successful completions only", () => {
  const tracker = new RequestTracker();

  const reqId1 = tracker.createRequest(1);
  const reqId2 = tracker.createRequest(1);

  tracker.markPending(
    reqId1,
    () => {},
    () => {},
  );
  tracker.markPending(
    reqId2,
    () => {},
    () => {},
  );

  tracker.markCompleted(reqId1, 1);
  assert.strictEqual(tracker.getTotalCompleted(), 1);

  tracker.markError(reqId2, new Error("boom"));
  // Errors should not increase the completion counter.
  assert.strictEqual(tracker.getTotalCompleted(), 1);
});

it("RequestTracker - pending counts per worker", () => {
  const tracker = new RequestTracker();

  // Create requests for 3 workers
  const reqId1 = tracker.createRequest(3); // worker 0
  const reqId2 = tracker.createRequest(3); // worker 1
  const reqId3 = tracker.createRequest(3); // worker 2

  tracker.markPending(
    reqId1,
    () => {},
    () => {},
  );
  tracker.markPending(
    reqId2,
    () => {},
    () => {},
  );
  tracker.markPending(
    reqId3,
    () => {},
    () => {},
  );

  const counts = tracker.getPendingCounts();
  assert.strictEqual(counts.length, 3);
  assert.strictEqual(counts[0], 1);
  assert.strictEqual(counts[1], 1);
  assert.strictEqual(counts[2], 1);

  tracker.markCompleted(reqId1, 1);

  const countsAfter = tracker.getPendingCounts();
  assert.strictEqual(countsAfter[0], 0);
  assert.strictEqual(countsAfter[1], 1);
  assert.strictEqual(countsAfter[2], 1);
});

it("RequestTracker - instrumentation hooks", () => {
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

  tracker.markPending(
    reqId,
    () => {},
    () => {},
  );
  assert.strictEqual(queuedCalled, true);

  tracker.markCompleted(reqId, 1);
  assert.strictEqual(completedCalled, true);

  const reqId2 = tracker.createRequest(1);
  tracker.markPending(
    reqId2,
    () => {},
    () => {},
  );
  tracker.incrementResubmit(reqId2);
  tracker.recordYield(reqId2, 100, 1);
  assert.strictEqual(yieldCalled, true);

  tracker.markError(reqId2, new Error("test"));
  assert.strictEqual(errorCalled, true);
});
