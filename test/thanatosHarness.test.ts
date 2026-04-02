/**
 * Test harness for running SKI reduction via the native thanatos binary.
 * Uses a single long-lived daemon process (singleton). All tests share one thanatos;
 * runThanatosBatch sends expressions through the session with surface↔DAG conversion.
 */

import { assert, assertEquals, assertRejects } from "std/assert";
import { existsSync } from "std/fs";
import { join } from "std/path";
import { parseSKI } from "../lib/parser/ski.ts";
import { unparseSKI } from "../lib/ski/expression.ts";
import { fromDagWire, toDagWire } from "../lib/ski/dagWire.ts";
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

  const program = await Deno.readTextFile(inputSkiPath);
  const stdin = await Deno.readFile(stdinPath);
  const expectedStdout = await Deno.readFile(expectedStdoutPath);

  const expr = parseSKI(program);
  const dag = toDagWire(expr);

  const tempDir = await Deno.makeTempDir();
  const inPath = join(tempDir, "stdin.bin");
  const outPath = join(tempDir, "stdout.bin");
  const reduceSnapshot = async () => {
    await Deno.writeFile(inPath, stdin);
    const actualResultDag = await session.reduceFile(
      dag,
      inPath,
      outPath,
    );
    const actualStdout = await Deno.readFile(outPath);
    return { actualResultDag, actualStdout };
  };

  try {
    let actualResultDag: string;
    let actualStdout: Uint8Array;
    try {
      ({ actualResultDag, actualStdout } = await reduceSnapshot());
    } catch (error) {
      const isWindowsRetryableMapFailure = Deno.build.os === "windows" &&
        error instanceof Error &&
        error.message.includes("thanatos: mmap output failed");
      if (!isWindowsRetryableMapFailure) {
        throw error;
      }
      await Deno.remove(outPath).catch(() => {});
      await session.reset();
      ({ actualResultDag, actualStdout } = await reduceSnapshot());
    }

    assertEquals(
      actualStdout,
      expectedStdout,
      `Snapshot "${name}" did not produce expected stdout`,
    );

    if (existsSync(expectedResultDagPath)) {
      const expectedResultDag = await Deno.readTextFile(expectedResultDagPath);
      // Compare unparsed SKI to avoid fragile DAG string matches if possible,
      // or just compare DAG if intended.
      assertEquals(
        unparseSKI(fromDagWire(actualResultDag)),
        unparseSKI(fromDagWire(expectedResultDag)),
        `Snapshot "${name}" did not produce expected result DAG`,
      );
    }
  } finally {
    await Deno.remove(tempDir, { recursive: true }).catch(() => {});
  }
}

async function waitForTraceDump(
  traceDir: string,
  timeoutMs = 2000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const dumps: string[] = [];
    for await (const entry of Deno.readDir(traceDir)) {
      if (entry.isFile && entry.name.endsWith(".json")) {
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
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for thanatos trace dump in ${traceDir}`);
}

async function waitForTraceDumpCount(
  traceDir: string,
  expectedCount: number,
  timeoutMs = 2000,
): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const dumps = new Map<string, true>();
    for await (const entry of Deno.readDir(traceDir)) {
      if (entry.isFile && entry.name.endsWith(".json")) {
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
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(
    `timed out waiting for ${expectedCount} thanatos trace dumps in ${traceDir}`,
  );
}

async function tryReadTraceDumpJson(path: string): Promise<unknown | null> {
  try {
    const text = await Deno.readTextFile(path);
    if (text.trim().length === 0) {
      return null;
    }
    return JSON.parse(text);
  } catch (error) {
    if (
      error instanceof SyntaxError ||
      error instanceof Deno.errors.NotFound
    ) {
      return null;
    }
    throw error;
  }
}

async function readTraceDumpJson<T>(
  path: string,
  timeoutMs = 500,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const dump = await tryReadTraceDumpJson(path);
    if (dump !== null) {
      return dump as T;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for thanatos trace JSON at ${path}`);
}

const HARNESS_TRACE_TIMEOUT_MS = "200";
const HARNESS_WORKERS = defaultWorkerCount();
const HARNESS_WORKER_IDS = Array.from(
  { length: HARNESS_WORKERS },
  (_, workerId) => workerId,
);
const HARNESS_COMPLETE_STATES = Array(HARNESS_WORKERS).fill(true);
const HARNESS_IDLE_STATES = Array(HARNESS_WORKERS).fill("idle");
let harnessTraceDirPromise:
  | Promise<
    { path: string; owned: boolean }
  >
  | null = null;

async function getHarnessTraceDir(): Promise<string> {
  if (harnessTraceDirPromise === null) {
    harnessTraceDirPromise = Promise.resolve().then(async () => {
      const externalTraceDir = Deno.env.get("THANATOS_TRACE_DIR");
      if (externalTraceDir) {
        return { path: externalTraceDir, owned: false };
      }
      return { path: await Deno.makeTempDir(), owned: true };
    });
  }
  return (await harnessTraceDirPromise).path;
}

async function clearHarnessTraceDumps(traceDir: string): Promise<void> {
  for await (const entry of Deno.readDir(traceDir)) {
    if (entry.isFile && entry.name.endsWith(".json")) {
      await Deno.remove(join(traceDir, entry.name)).catch(() => {});
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
    await Deno.remove(traceDir.path, { recursive: true }).catch(() => {});
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

Deno.test({
  name: "thanatos session suite",
  ignore: !thanatosAvailable(),
  fn: async (t) => {
    try {
      await t.step("session based IO - readOne echo", async () => {
        await withHarnessSession(async (session) => {
          await runThanatosSnapshot("readOneEcho", session);
        });
      });

      await t.step(
        "native IO - multiple writeOne ABC preserves sequential order via session (streaming)",
        async () => {
          await withHarnessSession(async (session) => {
            for (let i = 0; i < 32; i++) {
              await runThanatosSnapshot("writeOneABC", session);
            }
          });
        },
      );

      await t.step("native IO - readOne via session (streaming)", async () => {
        await withHarnessSession(async (session) => {
          await runThanatosSnapshot("readOneA", session);
        });
      });

      await t.step(
        "native IO - interleaved read/write echo via session",
        async () => {
          await withHarnessSession(async (session) => {
            await runThanatosSnapshot("interleavedEcho", session);
          });
        },
      );

      await t.step(
        "native IO - readOne echo via zero-copy mmap file session",
        async () => {
          await withHarnessSession(async (session) => {
            await runThanatosSnapshot("readOneMmapS", session);
          });
        },
      );

      await t.step("RESET after several reductions then REDUCE", async () => {
        await withHarnessSession(async (session) => {
          const r1 = await session.reduceDag(toDagWire(parseSKI("I S")));
          assertEquals(unparseSKI(fromDagWire(r1)), "S");
          const r2 = await session.reduceDag(toDagWire(parseSKI("K S K")));
          assertEquals(unparseSKI(fromDagWire(r2)), "S");
          await session.reset();
          const r3 = await session.reduceDag(toDagWire(parseSKI("I K")));
          assertEquals(unparseSKI(fromDagWire(r3)), "K");
        });
      });

      await t.step("daemon PING RESET STATS QUIT", async () => {
        await withHarnessSession(async (session) => {
          await session.ping();
          await session.reset();
          const statsLine = await session.stats();
          assert(
            statsLine.includes("top=") &&
              statsLine.includes("capacity=") &&
              statsLine.includes("total_nodes=") &&
              statsLine.includes("total_steps=") &&
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

      await t.step(
        "thanatos trace dump - TRACE_DUMP writes JSON worker snapshot",
        async () => {
          const traceDir = await prepareHarnessTraceDir();
          await withHarnessSession(async (session) => {
            await session.ping();
            const resultDag = await session.reduceDag(
              toDagWire(parseSKI("I K")),
            );
            assertEquals(unparseSKI(fromDagWire(resultDag)), "K");

            await session.traceDump();
            const dumpPath = await waitForTraceDump(traceDir);
            const dump = await readTraceDumpJson<{
              dump_version: number;
              epoch: number;
              runtime: { worker_count: number };
              workers: Array<{
                worker_id: number;
                complete: boolean;
                recent_events: Array<{ kind: string }>;
              }>;
            }>(dumpPath);

            assertEquals(dump.dump_version, 1);
            assert(dump.epoch >= 1);
            assertEquals(dump.runtime.worker_count, HARNESS_WORKERS);
            assertEquals(dump.workers.length, HARNESS_WORKERS);
            assertEquals(
              dump.workers.map((worker) => worker.worker_id),
              HARNESS_WORKER_IDS,
            );
            assertEquals(
              dump.workers.map((worker) => worker.complete),
              HARNESS_COMPLETE_STATES,
            );
            assert(
              dump.workers.some((worker) => worker.recent_events.length > 0),
              `expected non-empty recent_events in ${dumpPath}`,
            );
          });
        },
      );

      await t.step(
        "thanatos trace dump - idle multi-worker snapshot is complete",
        async () => {
          const traceDir = await prepareHarnessTraceDir();
          await withHarnessSession(async (session) => {
            await session.ping();

            await session.traceDump();
            const dumpPath = await waitForTraceDump(traceDir);
            const dump = await readTraceDumpJson<{
              runtime: { worker_count: number };
              workers: Array<{
                worker_id: number;
                complete: boolean;
                state: string;
              }>;
            }>(dumpPath);

            assertEquals(dump.runtime.worker_count, HARNESS_WORKERS);
            assertEquals(dump.workers.length, HARNESS_WORKERS);
            assertEquals(
              dump.workers.map((worker) => worker.worker_id),
              HARNESS_WORKER_IDS,
            );
            assertEquals(
              dump.workers.map((worker) => worker.complete),
              HARNESS_COMPLETE_STATES,
            );
            assertEquals(
              dump.workers.map((worker) => worker.state),
              HARNESS_IDLE_STATES,
            );
          });
        },
      );

      await t.step(
        "thanatos trace dump - repeated TRACE_DUMP increments epoch files",
        async () => {
          const traceDir = await prepareHarnessTraceDir();
          await withHarnessSession(async (session) => {
            await session.ping();
            await session.reduceDag(toDagWire(parseSKI("I S")));

            await session.traceDump();
            await waitForTraceDump(traceDir);
            await session.traceDump();

            const dumpPaths = await waitForTraceDumpCount(traceDir, 2);
            const dumps = await Promise.all(
              dumpPaths.map(async (path) =>
                await readTraceDumpJson<{
                  epoch: number;
                  runtime: { worker_count: number };
                  workers: Array<{ complete: boolean }>;
                }>(path)
              ),
            );
            dumps.sort((a, b) => a.epoch - b.epoch);

            const epochs = dumps.map((dump) => dump.epoch);
            assertEquals(epochs.length, 2);
            assertEquals(epochs[1], (epochs[0] ?? 0) + 1);
            assertEquals(
              dumps.map((dump) => dump.runtime.worker_count),
              [HARNESS_WORKERS, HARNESS_WORKERS],
            );
            assertEquals(
              dumps.map((dump) => dump.workers.length),
              [HARNESS_WORKERS, HARNESS_WORKERS],
            );
            assertEquals(
              dumps.map((dump) =>
                dump.workers.every((worker) => worker.complete)
              ),
              [true, true],
            );
          });
        },
      );

      await t.step("REDUCE_FILE - rejects path > 1023 chars", async () => {
        await withHarnessSession(async (session) => {
          const longPath = "a".repeat(1024);
          const res = await session.rawRequest(
            `REDUCE_FILE ${longPath} out.bin I`,
          );
          assertEquals(res, "ERR path too long (max 1023 chars)");

          const res2 = await session.rawRequest(
            `REDUCE_FILE in.bin "${longPath}" I`,
          );
          assertEquals(res2, "ERR path too long (max 1023 chars)");
        });
      });

      await t.step("REDUCE_FILE - rejects missing input file", async () => {
        const outPath = await Deno.makeTempFile();
        try {
          await withHarnessSession(async (session) => {
            const res = await session.rawRequest(
              `REDUCE_FILE missing-input.bin "${outPath}" I`,
            );
            assertEquals(res, "ERR cannot open input file");
          });
        } finally {
          await Deno.remove(outPath).catch(() => {});
        }
      });

      await t.step(
        "REDUCE_FILE - empty input file fails with EOF-backed reduction error",
        async () => {
          const inPath = await Deno.makeTempFile();
          const outPath = await Deno.makeTempFile();
          try {
            await withHarnessSession(async (session) => {
              const dag = toDagWire(parseSKI(", (C . I) I"));
              await Deno.writeFile(inPath, new Uint8Array(0));
              await assertRejects(
                () => session.reduceFile(dag, inPath, outPath),
                Error,
                "thanatos: reduction error",
              );
              assertEquals((await Deno.stat(outPath)).size, 0);
            });
          } finally {
            await Deno.remove(inPath).catch(() => {});
            await Deno.remove(outPath).catch(() => {});
          }
        },
      );

      await t.step("ThanatosSession - reduceDag error (coverage)", async () => {
        await withHarnessSession(async (session) => {
          await assertRejects(
            () => session.reduceDag("INVALID"),
            Error,
            "thanatos: parse error",
          );
        });
      });
    } finally {
      await closeBatchThanatosSessions();
      await cleanupHarnessTraceDir();
    }
  },
});

Deno.test({
  name:
    "thanatos CLI - daemon mode (always on) trims blank lines and responds with OK",
  ignore: !thanatosAvailable(),
  fn: async () => {
    const result = await runThanatosProcess(
      ["1", "65536"],
      "\n  \nREDUCE I U41 @0,1   \r\n",
    );
    assertEquals(result.code, 0, result.stderr);
    // OK <result_dag>
    // Result of (I U41) is U41
    assertEquals(normalizeCliOutput(result.stdout), "OK U41\n");
  },
});

Deno.test({
  name: "thanatos CLI - --stdin-file reads runtime stdin",
  ignore: !thanatosAvailable(),
  fn: async () => {
    const stdinPath = await Deno.makeTempFile();
    try {
      await Deno.writeFile(stdinPath, new Uint8Array([0x2a]));
      const result = await runThanatosProcess(
        ["--stdin-file", stdinPath, "1", "65536"],
        "REDUCE , I @0,1\n",
      );
      assertEquals(result.code, 0, result.stderr);
      assertEquals(normalizeCliOutput(result.stdout), "OK U2a\n");
    } finally {
      await Deno.remove(stdinPath).catch(() => {});
    }
  },
});

Deno.test({
  name: "thanatos CLI - argument validation",
  ignore: !thanatosAvailable(),
  fn: async (t) => {
    await t.step("--stdin-file requires a path", async () => {
      const result = await runThanatosProcess(["--stdin-file"]);
      assertEquals(result.code, 1);
      assert(
        result.stderr.includes("--stdin-file requires a path"),
        result.stderr,
      );
    });

    await t.step("invalid worker count", async () => {
      const result = await runThanatosProcess(["bogus"]);
      assertEquals(result.code, 1);
      assert(
        result.stderr.includes("invalid worker count: bogus"),
        result.stderr,
      );
    });

    await t.step("invalid arena capacity", async () => {
      const result = await runThanatosProcess(["1", "bogus"]);
      assertEquals(result.code, 1);
      assert(
        result.stderr.includes("invalid arena capacity: bogus"),
        result.stderr,
      );
    });

    await t.step("cannot open runtime stdin file", async () => {
      const missingPath = join(PROJECT_ROOT, "missing-runtime-stdin.bin");
      const result = await runThanatosProcess([
        "--stdin-file",
        missingPath,
      ]);
      assertEquals(result.code, 1);
      assert(
        result.stderr.includes(`cannot open --stdin-file ${missingPath}`),
        result.stderr,
      );
    });
  },
});
