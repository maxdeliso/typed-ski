/**
 * Test harness for running SKI reduction via the native thanatos binary.
 * Uses a single long-lived daemon process (singleton). All tests share one thanatos;
 * runThanatosBatch sends expressions through the session with surface↔DAG conversion.
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, rm, stat, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { type TestContext, describe, it, waitFor } from "./util/test_shim.ts";
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

const HARNESS_WORKERS = defaultWorkerCount();

async function withHarnessSession<T>(
  callback: (session: ThanatosSession) => Promise<T>,
): Promise<T> {
  return await withBatchThanatosSession(callback, {
    key: "thanatosHarness",
    workers: HARNESS_WORKERS,
    env: {},
  });
}

describe("thanatos session suite", { skip: !thanatosAvailable() }, async () => {
  try {
    it("session based IO - readOne echo", async () => {
      await withHarnessSession(async (session) => {
        await runThanatosSnapshot("readOneEcho", session);
      });
    });

    it("native IO - multiple writeOne ABC preserves sequential order via session (streaming)", async () => {
      await withHarnessSession(async (session) => {
        for (let i = 0; i < 32; i++) {
          await runThanatosSnapshot("writeOneABC", session);
        }
      });
    });

    it("native IO - readOne via session (streaming)", async () => {
      await withHarnessSession(async (session) => {
        await runThanatosSnapshot("readOneA", session);
      });
    });

    it("native IO - interleaved read/write echo via session", async () => {
      await withHarnessSession(async (session) => {
        await runThanatosSnapshot("interleavedEcho", session);
      });
    });

    it("native IO - readOne echo via zero-copy mmap file session", async () => {
      await withHarnessSession(async (session) => {
        await runThanatosSnapshot("readOneMmapS", session);
      });
    });

    it("RESET after several reductions then REDUCE", async () => {
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

    it("daemon PING RESET STATS QUIT", async () => {
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
            statsLine.includes("bulk_fusion_checks=") &&
            statsLine.includes("bulk_fusion_candidates=") &&
            statsLine.includes("bulk_fusion_hits=") &&
            statsLine.includes("events=") &&
            statsLine.includes("dropped="),
          "STATS missing expected fields: " + statsLine,
        );
      });
    });

    it("REDUCE_FILE - rejects path > 1023 chars", async () => {
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

    it("REDUCE_FILE - rejects missing input file", async () => {
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

    it("REDUCE_FILE - empty input file fails with EOF-backed reduction error", async () => {
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
    });

    it("ThanatosSession - reduceDag error (coverage)", async () => {
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
  }
});

it(
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

it(
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

describe(
  "thanatos CLI - argument validation",
  { skip: !thanatosAvailable() },
  () => {
    it("--stdin-file requires a path", async () => {
      const result = await runThanatosProcess(["--stdin-file"]);
      assert.equal(result.code, 1);
      assert.ok(
        result.stderr.includes("--stdin-file requires a path"),
        result.stderr,
      );
    });

    it("invalid worker count", async () => {
      const result = await runThanatosProcess(["bogus"]);
      assert.equal(result.code, 1);
      assert.ok(
        result.stderr.includes("invalid worker count: bogus"),
        result.stderr,
      );
    });

    it("invalid arena capacity", async () => {
      const result = await runThanatosProcess(["1", "bogus"]);
      assert.equal(result.code, 1);
      assert.ok(
        result.stderr.includes("invalid arena capacity: bogus"),
        result.stderr,
      );
    });

    it("cannot open runtime stdin file", async () => {
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
