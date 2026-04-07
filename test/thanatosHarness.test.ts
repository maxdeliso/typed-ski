/**
 * Test harness for running SKI reduction via the native thanatos binary.
 * Uses a single long-lived daemon process (singleton). All tests share one thanatos;
 * runThanatosBatch sends expressions through the session with surface↔DAG conversion.
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, rm, mkdtemp, stat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test, type TestContext } from "node:test";
import { parseSKI } from "../lib/parser/ski.ts";
import { unparseSKI } from "../lib/ski/expression.ts";
import { fromTopoDagWire, toTopoDagWire } from "../lib/ski/topoDagWire.ts";
import {
  closeBatchThanatosSessions,
  defaultWorkerCount,
  normalizeCliOutput,
  PROJECT_ROOT,
  runThanatosProcess,
  thanatosAvailable,
  withBatchThanatosSession,
} from "./thanatosHarness.ts";
import type { ThanatosSession } from "./thanatosHarness.ts";

/**
 * Internal helper for snapshot testing with a thanatos session.
 */
async function runThanatosSnapshot(
  name: string,
  session: ThanatosSession,
): Promise<void> {
  const snapshotDir = join(PROJECT_ROOT, "test", "thanatosSnapshots", name);
  const inputSkiPath = join(snapshotDir, "input.ski");
  const stdinPath = join(snapshotDir, "stdin.bin");
  const expectedStdoutPath = join(snapshotDir, "stdout.bin");
  const expectedResultDagPath = join(snapshotDir, "result.dag");

  const program = await readFile(inputSkiPath, "utf8");
  const expectedStdout = await readFile(expectedStdoutPath);

  const expr = parseSKI(program);
  const dag = toTopoDagWire(expr);

  const tempDir = await mkdtemp(join(tmpdir(), "thanatos-snapshot-"));
  const outPath = join(tempDir, "stdout.bin");
  const reduceSnapshot = async () => {
    const actualResultDag = await session.reduceFile(dag, stdinPath, outPath);
    const actualStdout = await readFile(outPath);
    return { actualResultDag, actualStdout };
  };

  try {
    let actualResultDag: string;
    let actualStdout: Uint8Array;
    try {
      ({ actualResultDag, actualStdout } = await reduceSnapshot());
    } catch (error: any) {
      const isWindowsRetryableMapFailure =
        process.platform === "win32" &&
        error instanceof Error &&
        error.message.includes("thanatos: mmap output failed");
      if (!isWindowsRetryableMapFailure) {
        throw error;
      }
      await rm(outPath).catch(() => {});
      await session.reset();
      ({ actualResultDag, actualStdout } = await reduceSnapshot());
    }

    assert.deepEqual(
      actualStdout,
      expectedStdout,
      `Snapshot "${name}" did not produce expected stdout`,
    );

    if (existsSync(expectedResultDagPath)) {
      const expectedResultDag = await readFile(expectedResultDagPath, "utf8");
      assert.equal(
        unparseSKI(fromTopoDagWire(actualResultDag)),
        unparseSKI(fromTopoDagWire(expectedResultDag)),
        `Snapshot "${name}" did not produce expected result DAG`,
      );
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function waitForTraceDump(
  t: TestContext,
  traceDir: string,
  timeoutMs = 2000,
): Promise<string> {
  return await t.waitFor(
    async () => {
      const dumps: string[] = [];
      const entries = await readdir(traceDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith(".json")) {
          dumps.push(join(traceDir, entry.name));
        }
      }
      dumps.sort();
      for (let i = dumps.length - 1; i >= 0; i--) {
        const dumpPath = dumps[i]!;
        if ((await tryReadTraceDumpJson(dumpPath)) !== null) {
          return dumpPath;
        }
      }
      throw new Error(`trace dump not ready in ${traceDir}`);
    },
    {
      interval: 20,
      timeout: timeoutMs,
    },
  );
}

async function waitForTraceDumpCount(
  t: TestContext,
  traceDir: string,
  expectedCount: number,
  timeoutMs = 2000,
): Promise<string[]> {
  return await t.waitFor(
    async () => {
      const dumps = new Map<string, true>();
      const entries = await readdir(traceDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith(".json")) {
          const dumpPath = join(traceDir, entry.name);
          if ((await tryReadTraceDumpJson(dumpPath)) !== null) {
            dumps.set(dumpPath, true);
          }
        }
      }
      const paths = Array.from(dumps.keys()).sort();
      if (paths.length >= expectedCount) {
        return paths;
      }
      throw new Error(
        `waiting for ${expectedCount} thanatos trace dumps in ${traceDir}`,
      );
    },
    {
      interval: 20,
      timeout: timeoutMs,
    },
  );
}

async function tryReadTraceDumpJson(path: string): Promise<unknown | null> {
  try {
    const text = await readFile(path, "utf8");
    if (text.trim().length === 0) {
      return null;
    }
    return JSON.parse(text);
  } catch (error: any) {
    if (error instanceof SyntaxError || error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function readTraceDumpJson<T>(
  t: TestContext,
  path: string,
  timeoutMs = 500,
): Promise<T> {
  return await t.waitFor(
    async () => {
      const dump = await tryReadTraceDumpJson(path);
      if (dump !== null) {
        return dump as T;
      }
      throw new Error(`trace JSON not ready at ${path}`);
    },
    {
      interval: 20,
      timeout: timeoutMs,
    },
  );
}

const HARNESS_TRACE_TIMEOUT_MS = "200";
const HARNESS_WORKERS = defaultWorkerCount();
const HARNESS_WORKER_IDS = Array.from(
  { length: HARNESS_WORKERS },
  (_, workerId) => workerId,
);
const HARNESS_COMPLETE_STATES = Array(HARNESS_WORKERS).fill(true);
const HARNESS_IDLE_STATES = Array(HARNESS_WORKERS).fill("idle");
let harnessTraceDirPromise: Promise<{ path: string; owned: boolean }> | null =
  null;

async function getHarnessTraceDir(): Promise<string> {
  if (harnessTraceDirPromise === null) {
    harnessTraceDirPromise = Promise.resolve().then(async () => {
      const externalTraceDir = process.env["THANATOS_TRACE_DIR"];
      if (externalTraceDir) {
        return { path: externalTraceDir, owned: false };
      }
      return {
        path: await mkdtemp(join(tmpdir(), "thanatos-harness-")),
        owned: true,
      };
    });
  }
  return (await harnessTraceDirPromise).path;
}

async function clearHarnessTraceDumps(traceDir: string): Promise<void> {
  const entries = await readdir(traceDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith(".json")) {
      await rm(join(traceDir, entry.name)).catch(() => {});
    }
  }
}

async function prepareHarnessTraceDir(): Promise<string> {
  const traceDir = await getHarnessTraceDir();
  await clearHarnessTraceDumps(traceDir);
  return traceDir;
}

async function cleanupHarnessTraceDir(): Promise<void> {
  if (harnessTraceDirPromise === null) {
    return;
  }
  const traceDir = await harnessTraceDirPromise;
  harnessTraceDirPromise = null;
  if (traceDir.owned) {
    await rm(traceDir.path, { recursive: true, force: true }).catch(() => {});
  }
}

async function withHarnessSession<T>(
  callback: (session: ThanatosSession) => Promise<T>,
): Promise<T> {
  const traceDir = await getHarnessTraceDir();
  return await withBatchThanatosSession(callback, {
    key: "thanatosHarness",
    workers: HARNESS_WORKERS,
    env: {
      THANATOS_TRACE_DIR: traceDir,
      THANATOS_TRACE_TIMEOUT_MS: HARNESS_TRACE_TIMEOUT_MS,
    },
  });
}

test("thanatos session suite", { skip: !thanatosAvailable() }, async (t) => {
  try {
    await t.test("session based IO - readOne echo", async () => {
      await withHarnessSession(async (session) => {
        await runThanatosSnapshot("readOneEcho", session);
      });
    });

    await t.test(
      "native IO - multiple writeOne ABC preserves sequential order via session (streaming)",
      async () => {
        await withHarnessSession(async (session) => {
          for (let i = 0; i < 32; i++) {
            await runThanatosSnapshot("writeOneABC", session);
          }
        });
      },
    );

    await t.test("native IO - readOne via session (streaming)", async () => {
      await withHarnessSession(async (session) => {
        await runThanatosSnapshot("readOneA", session);
      });
    });

    await t.test(
      "native IO - interleaved read/write echo via session",
      async () => {
        await withHarnessSession(async (session) => {
          await runThanatosSnapshot("interleavedEcho", session);
        });
      },
    );

    await t.test(
      "native IO - readOne echo via zero-copy mmap file session",
      async () => {
        await withHarnessSession(async (session) => {
          await runThanatosSnapshot("readOneMmapS", session);
        });
      },
    );

    await t.test("RESET after several reductions then REDUCE", async () => {
      await withHarnessSession(async (session) => {
        const r1 = await session.reduceDag(toTopoDagWire(parseSKI("I S")));
        assert.equal(unparseSKI(fromTopoDagWire(r1)), "S");
        const r2 = await session.reduceDag(toTopoDagWire(parseSKI("K S K")));
        assert.equal(unparseSKI(fromTopoDagWire(r2)), "S");
        await session.reset();
        const r3 = await session.reduceDag(toTopoDagWire(parseSKI("I K")));
        assert.equal(unparseSKI(fromTopoDagWire(r3)), "K");
      });
    });

    await t.test("daemon PING RESET STATS QUIT", async () => {
      await withHarnessSession(async (session) => {
        await session.ping();
        await session.reset();
        const statsLine = await session.stats();
        assert.ok(
          statsLine.includes("top=") &&
            statsLine.includes("capacity=") &&
            statsLine.includes("total_nodes=") &&
            statsLine.includes("total_steps=") &&
            statsLine.includes("total_link_chase_hops=") &&
            statsLine.includes("total_cons_allocs=") &&
            statsLine.includes("total_cont_allocs=") &&
            statsLine.includes("total_susp_allocs=") &&
            statsLine.includes("duplicate_lost_allocs=") &&
            statsLine.includes("hashcons_hits=") &&
            statsLine.includes("hashcons_misses=") &&
            statsLine.includes("events=") &&
            statsLine.includes("dropped="),
          "STATS missing expected fields: " + statsLine,
        );
      });
    });

    await t.test(
      "thanatos trace dump - TRACE_DUMP writes JSON worker snapshot",
      async () => {
        const traceDir = await prepareHarnessTraceDir();
        await withHarnessSession(async (session) => {
          await session.ping();
          const resultDag = await session.reduceDag(
            toTopoDagWire(parseSKI("I K")),
          );
          assert.equal(unparseSKI(fromTopoDagWire(resultDag)), "K");

          await session.traceDump();
          const dumpPath = await waitForTraceDump(t, traceDir);
          const dump = await readTraceDumpJson<{
            dump_version: number;
            epoch: number;
            runtime: { worker_count: number };
            workers: Array<{
              worker_id: number;
              complete: boolean;
              recent_events: Array<{ kind: string }>;
            }>;
          }>(t, dumpPath);

          assert.equal(dump.dump_version, 1);
          assert.ok(dump.epoch >= 1);
          assert.equal(dump.runtime.worker_count, HARNESS_WORKERS);
          assert.equal(dump.workers.length, HARNESS_WORKERS);
          assert.deepEqual(
            dump.workers.map((worker) => worker.worker_id),
            HARNESS_WORKER_IDS,
          );
          assert.deepEqual(
            dump.workers.map((worker) => worker.complete),
            HARNESS_COMPLETE_STATES,
          );
          assert.ok(
            dump.workers.some((worker) => worker.recent_events.length > 0),
            `expected non-empty recent_events in ${dumpPath}`,
          );
        });
      },
    );

    await t.test(
      "thanatos trace dump - idle multi-worker snapshot is complete",
      async () => {
        const traceDir = await prepareHarnessTraceDir();
        await withHarnessSession(async (session) => {
          await session.ping();

          await session.traceDump();
          const dumpPath = await waitForTraceDump(t, traceDir);
          const dump = await readTraceDumpJson<{
            runtime: { worker_count: number };
            workers: Array<{
              worker_id: number;
              complete: boolean;
              state: string;
            }>;
          }>(t, dumpPath);

          assert.equal(dump.runtime.worker_count, HARNESS_WORKERS);
          assert.equal(dump.workers.length, HARNESS_WORKERS);
          assert.deepEqual(
            dump.workers.map((worker) => worker.worker_id),
            HARNESS_WORKER_IDS,
          );
          assert.deepEqual(
            dump.workers.map((worker) => worker.complete),
            HARNESS_COMPLETE_STATES,
          );
          assert.deepEqual(
            dump.workers.map((worker) => worker.state),
            HARNESS_IDLE_STATES,
          );
        });
      },
    );

    await t.test(
      "thanatos trace dump - repeated TRACE_DUMP increments epoch files",
      async () => {
        const traceDir = await prepareHarnessTraceDir();
        await withHarnessSession(async (session) => {
          await session.ping();
          await session.reduceDag(toTopoDagWire(parseSKI("I S")));

          await session.traceDump();
          await waitForTraceDump(t, traceDir);
          await session.traceDump();

          const dumpPaths = await waitForTraceDumpCount(t, traceDir, 2);
          const dumps = await Promise.all(
            dumpPaths.map(
              async (path) =>
                await readTraceDumpJson<{
                  epoch: number;
                  runtime: { worker_count: number };
                  workers: Array<{ complete: boolean }>;
                }>(t, path),
            ),
          );
          dumps.sort((a, b) => a.epoch - b.epoch);

          const epochs = dumps.map((dump) => dump.epoch);
          assert.equal(epochs.length, 2);
          assert.equal(epochs[1], (epochs[0] ?? 0) + 1);
          assert.deepEqual(
            dumps.map((dump) => dump.runtime.worker_count),
            [HARNESS_WORKERS, HARNESS_WORKERS],
          );
          assert.deepEqual(
            dumps.map((dump) => dump.workers.length),
            [HARNESS_WORKERS, HARNESS_WORKERS],
          );
          assert.deepEqual(
            dumps.map((dump) =>
              dump.workers.every((worker) => worker.complete),
            ),
            [true, true],
          );
        });
      },
    );

    await t.test("REDUCE_FILE - rejects path > 1023 chars", async () => {
      await withHarnessSession(async (session) => {
        const longPath = "a".repeat(1024);
        const identityDag = toTopoDagWire(parseSKI("I"));
        const res = await session.rawRequest(
          `REDUCE_FILE ${longPath} out.bin ${identityDag}`,
        );
        assert.equal(res, "ERR path too long (max 1023 chars)");

        const res2 = await session.rawRequest(
          `REDUCE_FILE in.bin "${longPath}" ${identityDag}`,
        );
        assert.equal(res2, "ERR path too long (max 1023 chars)");
      });
    });

    await t.test("REDUCE_FILE - rejects missing input file", async () => {
      const outPath = join(tmpdir(), `thanatos-test-out-${randomUUID()}.bin`);
      try {
        await withHarnessSession(async (session) => {
          const identityDag = toTopoDagWire(parseSKI("I"));
          const res = await session.rawRequest(
            `REDUCE_FILE missing-input.bin "${outPath}" ${identityDag}`,
          );
          assert.equal(res, "ERR cannot open input file");
        });
      } finally {
        await rm(outPath).catch(() => {});
      }
    });

    await t.test(
      "REDUCE_FILE - empty input file fails with EOF-backed reduction error",
      async () => {
        const inPath = join(PROJECT_ROOT, "test", "inputs", "empty.bin");
        const outPath = join(tmpdir(), `thanatos-test-out-${randomUUID()}.bin`);
        try {
          await withHarnessSession(async (session) => {
            const dag = toTopoDagWire(parseSKI(", (C . I) I"));
            try {
              await session.reduceFile(dag, inPath, outPath);
              assert.fail("Expected reduction to fail");
            } catch (error: any) {
              assert.ok(
                error.message.includes("thanatos: reduction error") ||
                  error.message.includes("Internal error"),
                `Unexpected error message: ${error.message}`,
              );
            }
            assert.equal((await stat(outPath)).size, 0);
          });
        } finally {
          await rm(outPath).catch(() => {});
        }
      },
    );

    await t.test("ThanatosSession - reduceDag error (coverage)", async () => {
      await withHarnessSession(async (session) => {
        try {
          await session.reduceDag("INVALID");
          assert.fail("Expected reduction to fail");
        } catch (error: any) {
          assert.ok(
            error.message.includes("thanatos: parse error") ||
              error.message.includes("Internal error"),
            `Unexpected error message: ${error.message}`,
          );
        }
      });
    });
  } finally {
    await closeBatchThanatosSessions();
    await cleanupHarnessTraceDir();
  }
});

test(
  "thanatos CLI - daemon mode (always on) trims blank lines and responds with OK",
  { skip: !thanatosAvailable() },
  async () => {
    const dag = toTopoDagWire(parseSKI("I #u8(65)"));
    const result = await runThanatosProcess(
      ["1", "65536"],
      `\n  \nREDUCE ${dag}   \r\n`,
    );
    assert.equal(result.code, 0, result.stderr);
    assert.equal(
      normalizeCliOutput(result.stdout),
      `OK ${toTopoDagWire({ kind: "u8", value: 0x41 })}\n`,
    );
  },
);

test(
  "thanatos CLI - --stdin-file reads runtime stdin",
  { skip: !thanatosAvailable() },
  async () => {
    const stdinPath = join(PROJECT_ROOT, "test", "inputs", "forty-two.bin");
    const dag = toTopoDagWire(parseSKI(", I"));
    const result = await runThanatosProcess(
      ["--stdin-file", stdinPath, "1", "65536"],
      `REDUCE ${dag}\n`,
    );
    assert.equal(result.code, 0, result.stderr);
    assert.equal(
      normalizeCliOutput(result.stdout),
      `OK ${toTopoDagWire({ kind: "u8", value: 0x2a })}\n`,
    );
  },
);

test(
  "thanatos CLI - argument validation",
  { skip: !thanatosAvailable() },
  async (t) => {
    await t.test("--stdin-file requires a path", async () => {
      const result = await runThanatosProcess(["--stdin-file"]);
      assert.equal(result.code, 1);
      assert.ok(
        result.stderr.includes("--stdin-file requires a path"),
        result.stderr,
      );
    });

    await t.test("invalid worker count", async () => {
      const result = await runThanatosProcess(["bogus"]);
      assert.equal(result.code, 1);
      assert.ok(
        result.stderr.includes("invalid worker count: bogus"),
        result.stderr,
      );
    });

    await t.test("invalid arena capacity", async () => {
      const result = await runThanatosProcess(["1", "bogus"]);
      assert.equal(result.code, 1);
      assert.ok(
        result.stderr.includes("invalid arena capacity: bogus"),
        result.stderr,
      );
    });

    await t.test("cannot open runtime stdin file", async () => {
      const missingPath = join(PROJECT_ROOT, "missing-runtime-stdin.bin");
      const result = await runThanatosProcess(["--stdin-file", missingPath]);
      assert.equal(result.code, 1);
      assert.ok(
        result.stderr.includes(`cannot open --stdin-file ${missingPath}`),
        result.stderr,
      );
    });
  },
);

function randomUUID() {
  return Math.random().toString(36).substring(2, 15);
}
