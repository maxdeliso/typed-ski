import { assert, assertEquals } from "std/assert";
import type { ArenaWasmExports } from "../../../lib/evaluator/arenaEvaluator.ts";
import type { IoManager } from "../../../lib/evaluator/io/ioManager.ts";
import type { RingStats } from "../../../lib/evaluator/io/ringStats.ts";
import { CompletionPoller } from "../../../lib/evaluator/parallel/completionPoller.ts";
import { RequestTracker } from "../../../lib/evaluator/parallel/requestTracker.ts";
import { ArenaKind } from "../../../lib/shared/arena.ts";

class RingStatsStub {
  recordPullEmpty(): void {}
  recordPullNonEmpty(): void {}
  recordSubmitFull(): void {}
  recordCompletionStashed(): void {}
}

class IoManagerStub {
  public shouldHandle = false;
  registerIoWait(_nodeId: number, _reqId: number): void {}
  async handleIoWaitSuspension(
    nodeId: number,
    reqId: number,
    submitSuspension: (nodeId: number, reqId: number) => Promise<void>,
  ): Promise<boolean> {
    if (this.shouldHandle) {
      await submitSuspension(nodeId, reqId);
      return true;
    }
    return false;
  }
}

function pack(reqId: number, nodeId: number): bigint {
  return (BigInt(reqId >>> 0) << 32n) | BigInt(nodeId >>> 0);
}

function packV2(reqId: number, eventKind: number, nodeId: number): bigint {
  const low = ((eventKind & 0x3) << 30) | (nodeId & 0x3fffffff);
  return (BigInt(reqId >>> 0) << 32n) | BigInt(low >>> 0);
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

Deno.test("CompletionPoller - resubmits leaked continuation descendant instead of completing", async () => {
  const tracker = new RequestTracker({}, 8);
  const submits: Array<{ nodeId: number; reqId: number; maxSteps: number }> =
    [];
  const submitSeen = deferred<void>();

  // Node graph:
  // 100 (NonTerm) -> left: 101 (Terminal), right: 102 (Continuation)
  const fakeExports = {
    kindOf: (id: number): number => {
      if (id === 100) return ArenaKind.NonTerm;
      if (id === 101) return ArenaKind.Terminal;
      if (id === 102) return ArenaKind.Continuation;
      return ArenaKind.Terminal;
    },
    leftOf: (id: number): number => (id === 100 ? 101 : 0),
    rightOf: (id: number): number => (id === 100 ? 102 : 0),
    symOf: (_id: number): number => 0,
    hostSubmit: (nodeId: number, reqId: number, maxSteps: number): number => {
      submits.push({ nodeId, reqId, maxSteps });
      submitSeen.resolve();
      return 0;
    },
  } as unknown as ArenaWasmExports;

  let aborted = false;
  const poller = new CompletionPoller(
    tracker,
    new IoManagerStub() as unknown as IoManager,
    new RingStatsStub() as unknown as RingStats,
    fakeExports,
    () => aborted,
  );

  const reqId = tracker.createRequest(1);
  // Simulate that this request already yielded at least once.
  tracker.incrementResubmit(reqId);

  let resolved = false;
  let rejected = false;
  tracker.markPending(reqId, () => {
    resolved = true;
  }, () => {
    rejected = true;
  });

  let pulled = false;
  poller.start(() => {
    if (!pulled) {
      pulled = true;
      return pack(reqId, 100);
    }
    return -1n;
  });

  await submitSeen.promise;
  aborted = true;
  poller.stop();

  assertEquals(resolved, false);
  assertEquals(rejected, false);
  assertEquals(tracker.isPending(reqId), true);
  assertEquals(tracker.getResubmitCount(reqId), 2);
  assertEquals(submits.length, 1);
  assertEquals(submits[0], { nodeId: 100, reqId, maxSteps: 0xffffffff });
});

Deno.test("CompletionPoller - clean completion still resolves request", async () => {
  const tracker = new RequestTracker({}, 8);
  const fakeExports = {
    kindOf: (id: number): number => {
      if (id === 200) return ArenaKind.NonTerm;
      if (id === 201) return ArenaKind.Terminal;
      if (id === 202) return ArenaKind.Terminal;
      return ArenaKind.Terminal;
    },
    leftOf: (id: number): number => (id === 200 ? 201 : 0),
    rightOf: (id: number): number => (id === 200 ? 202 : 0),
    symOf: (_id: number): number => 0,
    hostSubmit: (_nodeId: number, _reqId: number, _maxSteps: number): number =>
      0,
  } as unknown as ArenaWasmExports;

  let aborted = false;
  const poller = new CompletionPoller(
    tracker,
    new IoManagerStub() as unknown as IoManager,
    new RingStatsStub() as unknown as RingStats,
    fakeExports,
    () => aborted,
  );

  const reqId = tracker.createRequest(1);
  tracker.incrementResubmit(reqId);
  const completionSeen = deferred<void>();

  let resolvedNode: number | null = null;
  tracker.markPending(reqId, (nodeId) => {
    resolvedNode = nodeId;
    completionSeen.resolve();
  }, () => {});

  let pulled = false;
  poller.start(() => {
    if (!pulled) {
      pulled = true;
      return pack(reqId, 200);
    }
    return -1n;
  });

  await completionSeen.promise;
  aborted = true;
  poller.stop();

  assertEquals(resolvedNode, 200);
  assertEquals(tracker.isPending(reqId), false);
});

Deno.test("CompletionPoller - prefers typed IO_WAIT events from hostPullV2", async () => {
  const tracker = new RequestTracker({}, 8);
  let ioWaitRegistered: { nodeId: number; reqId: number } | null = null;
  const ioWaitSeen = deferred<void>();

  const ioManager = new IoManagerStub();
  ioManager.shouldHandle = true;
  ioManager.registerIoWait = (nodeId: number, reqId: number) => {
    ioWaitRegistered = { nodeId, reqId };
  };
  const originalHandle = ioManager.handleIoWaitSuspension.bind(ioManager);
  let ioWaitHandledCount = 0;
  ioManager.handleIoWaitSuspension = async (nodeId, reqId, submit) => {
    ioWaitHandledCount++;
    const res = await originalHandle(nodeId, reqId, submit);
    ioWaitSeen.resolve();
    return res;
  };

  const fakeExports = {
    hostPullV2: (() => {
      let pulled = false;
      return () => {
        if (!pulled) {
          pulled = true;
          return packV2(1, 2, 77); // event=IO_WAIT, node=77
        }
        return -1n;
      };
    })(),
    kindOf: (_id: number): number => {
      throw new Error("typed path should not call kindOf for IO_WAIT event");
    },
    symOf: (_id: number): number => {
      throw new Error("typed path should not call symOf for IO_WAIT event");
    },
    leftOf: (_id: number): number => 0,
    rightOf: (_id: number): number => 0,
    hostSubmit: (nodeId: number, reqId: number, _maxSteps: number): number => {
      assertEquals(nodeId, 77);
      assertEquals(reqId, 1);
      return 0;
    },
  } as unknown as ArenaWasmExports;

  let aborted = false;
  const poller = new CompletionPoller(
    tracker,
    ioManager as unknown as IoManager,
    new RingStatsStub() as unknown as RingStats,
    fakeExports,
    () => aborted,
  );

  const reqId = tracker.createRequest(1);
  tracker.markPending(reqId, () => {}, () => {});

  poller.start(
    (fakeExports as unknown as { hostPullV2: () => bigint }).hostPullV2,
  );
  await ioWaitSeen.promise;
  aborted = true;
  poller.stop();

  assertEquals(ioWaitRegistered, { nodeId: 77, reqId: 1 });
  assertEquals(ioWaitHandledCount, 1);
  assertEquals(tracker.isPending(1), true);
});

Deno.test("CompletionPoller - handles CQ_EVENT_ERROR", async () => {
  const tracker = new RequestTracker({}, 8);
  const errorSeen = deferred<void>();
  let capturedError: Error | null = null;

  const fakeExports = {
    hostPullV2: (() => {
      let pulled = false;
      return () => {
        if (!pulled) {
          pulled = true;
          return packV2(1, 3, 0); // event=ERROR, req=1
        }
        return -1n;
      };
    })(),
  } as unknown as ArenaWasmExports;

  let aborted = false;
  const poller = new CompletionPoller(
    tracker,
    new IoManagerStub() as unknown as IoManager,
    new RingStatsStub() as unknown as RingStats,
    fakeExports,
    () => aborted,
  );

  const reqId = tracker.createRequest(1);
  tracker.markPending(reqId, () => {}, (err) => {
    capturedError = err;
    errorSeen.resolve();
  });

  poller.start(
    (fakeExports as unknown as { hostPullV2: () => bigint }).hostPullV2,
  );
  await errorSeen.promise;
  aborted = true;
  poller.stop();

  assert(capturedError !== null);
  const err = capturedError as Error;
  assert(err.message.includes("Worker reported error event"));
});

Deno.test("CompletionPoller - handles CQ_EVENT_YIELD", async () => {
  const tracker = new RequestTracker({}, 8);
  const resubmits: number[] = [];
  const yieldSeen = deferred<void>();

  const fakeExports = {
    hostPullV2: (() => {
      let pulled = false;
      return () => {
        if (!pulled) {
          pulled = true;
          return packV2(1, 1, 99); // event=YIELD, node=99
        }
        return -1n;
      };
    })(),
    symOf: () => 0,
    kindOf: () => ArenaKind.Terminal,
    hostSubmit: (nodeId: number, _reqId: number, _maxSteps: number): number => {
      resubmits.push(nodeId);
      yieldSeen.resolve();
      return 0;
    },
  } as unknown as ArenaWasmExports;

  let aborted = false;
  const poller = new CompletionPoller(
    tracker,
    new IoManagerStub() as unknown as IoManager,
    new RingStatsStub() as unknown as RingStats,
    fakeExports,
    () => aborted,
  );

  const reqId = tracker.createRequest(1);
  tracker.markPending(reqId, () => {}, () => {});

  poller.start(
    (fakeExports as unknown as { hostPullV2: () => bigint }).hostPullV2,
  );
  await yieldSeen.promise;
  aborted = true;
  poller.stop();

  assertEquals(resubmits, [99]);
  assertEquals(tracker.getResubmitCount(reqId), 1);
});

Deno.test("CompletionPoller - busy-waits when submission queue is full (rc=1)", async () => {
  const tracker = new RequestTracker({}, 8);
  let submits = 0;
  const completionSeen = deferred<void>();

  const fakeExports = {
    hostPullV2: (() => {
      let pulled = false;
      return () => {
        if (!pulled) {
          pulled = true;
          return packV2(1, 0, 200); // event=DONE, node=200
        }
        return -1n;
      };
    })(),
    kindOf: (id: number): number => {
      if (id === 200) return ArenaKind.NonTerm;
      if (id === 102) return ArenaKind.Continuation;
      return ArenaKind.Terminal;
    },
    leftOf: (_id: number): number => 102, // Force internal control node check to pass
    rightOf: (_id: number): number => 102,
    hostSubmit: (
      _nodeId: number,
      _reqId: number,
      _maxSteps: number,
    ): number => {
      submits++;
      if (submits < 3) return 1; // Full twice
      completionSeen.resolve();
      return 0;
    },
  } as unknown as ArenaWasmExports;

  let aborted = false;
  const poller = new CompletionPoller(
    tracker,
    new IoManagerStub() as unknown as IoManager,
    new RingStatsStub() as unknown as RingStats,
    fakeExports,
    () => aborted,
  );

  const reqId = tracker.createRequest(1);
  tracker.incrementResubmit(reqId); // Need resubmitCount > 0 for internal control node check
  tracker.markPending(reqId, () => {}, () => {});

  poller.start(
    (fakeExports as unknown as { hostPullV2: () => bigint }).hostPullV2,
  );
  await completionSeen.promise;
  aborted = true;
  poller.stop();

  assertEquals(submits, 3);
});

Deno.test("CompletionPoller - hibernation when no work pending", async () => {
  const tracker = new RequestTracker({}, 8);
  let pullCount = 0;
  const fakeExports = {
    hostPullV2: () => {
      pullCount++;
      return -1n;
    },
  } as unknown as ArenaWasmExports;

  let aborted = false;
  const poller = new CompletionPoller(
    tracker,
    new IoManagerStub() as unknown as IoManager,
    new RingStatsStub() as unknown as RingStats,
    fakeExports,
    () => aborted,
  );

  // No pending work initially
  poller.start(
    (fakeExports as unknown as { hostPullV2: () => bigint }).hostPullV2,
  );

  // Wait a bit to let it enter hibernation loop
  await new Promise((r) => setTimeout(r, 10));
  aborted = true;
  poller.stop();

  // It should have pulled once at most before entering hibernation if it checks pending first
  // Actually, in the code:
  // if (this.requestTracker.getTotalPending() === 0) { ... hibernate ... continue; }
  // packed = pull();
  // So if it hibernate, it doesn't pull.
  assertEquals(pullCount, 0);
});

Deno.test("CompletionPoller - submitSuspension busy-waits on full queue", async () => {
  const tracker = new RequestTracker({}, 8);
  const ioManager = new IoManagerStub();
  ioManager.shouldHandle = true;
  const ioWaitSeen = deferred<void>();
  let submits = 0;

  const fakeExports = {
    hostPullV2: (() => {
      let pulled = false;
      return () => {
        if (!pulled) {
          pulled = true;
          return packV2(1, 2, 88); // event=IO_WAIT, node=88
        }
        return -1n;
      };
    })(),
    hostSubmit: (
      _nodeId: number,
      _reqId: number,
      _maxSteps: number,
    ): number => {
      submits++;
      if (submits < 3) return 1;
      ioWaitSeen.resolve();
      return 0;
    },
    symOf: () => 2, // SUSPEND_MODE_IO_WAIT
    kindOf: () => ArenaKind.Suspension,
  } as unknown as ArenaWasmExports;

  let aborted = false;
  const poller = new CompletionPoller(
    tracker,
    ioManager as unknown as IoManager,
    new RingStatsStub() as unknown as RingStats,
    fakeExports,
    () => aborted,
  );

  const reqId = tracker.createRequest(1);
  tracker.markPending(reqId, () => {}, () => {});

  poller.start(
    (fakeExports as unknown as { hostPullV2: () => bigint }).hostPullV2,
  );
  await ioWaitSeen.promise;
  aborted = true;
  poller.stop();

  assertEquals(submits, 3);
});

Deno.test("CompletionPoller - resubmitSuspension busy-waits on full queue", async () => {
  const tracker = new RequestTracker({}, 8);
  const yieldSeen = deferred<void>();
  let submits = 0;

  const fakeExports = {
    hostPullV2: (() => {
      let pulled = false;
      return () => {
        if (!pulled) {
          pulled = true;
          return packV2(1, 1, 99); // event=YIELD, node=99
        }
        return -1n;
      };
    })(),
    hostSubmit: (
      _nodeId: number,
      _reqId: number,
      _maxSteps: number,
    ): number => {
      submits++;
      if (submits < 3) return 1;
      yieldSeen.resolve();
      return 0;
    },
    symOf: () => 0,
    kindOf: () => ArenaKind.Suspension,
  } as unknown as ArenaWasmExports;

  let aborted = false;
  const poller = new CompletionPoller(
    tracker,
    new IoManagerStub() as unknown as IoManager,
    new RingStatsStub() as unknown as RingStats,
    fakeExports,
    () => aborted,
  );

  const reqId = tracker.createRequest(1);
  tracker.markPending(reqId, () => {}, () => {});

  poller.start(
    (fakeExports as unknown as { hostPullV2: () => bigint }).hostPullV2,
  );
  await yieldSeen.promise;
  aborted = true;
  poller.stop();

  assertEquals(submits, 3);
});
