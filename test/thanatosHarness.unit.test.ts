import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, rm, mkdtemp } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { parseSKI } from "../lib/parser/ski.ts";
import { unparseSKI } from "../lib/ski/expression.ts";
import { fromDagWire, toDagWire } from "../lib/ski/dagWire.ts";
import {
  passthroughEvaluator,
  runThanatosBatch,
} from "./thanatosHarness/batch.ts";
import {
  defaultWorkerCount,
  thanatosAvailable,
} from "./thanatosHarness/config.ts";
import {
  closeBatchThanatosSessions,
  getBatchBrokerEnvVarNames,
  getThanatosSession,
  startThanatosBatchBroker,
  usingThanatosBatchBroker,
  withBatchThanatosSession,
} from "./thanatosHarness/session.ts";

const BROKER_TOKEN_HEADER = "x-thanatos-batch-token";

type ThanatosSnapshot = {
  dag: string;
  stdin: Uint8Array;
  stdinPath: string;
  stdout: Uint8Array;
  resultDag: string | null;
};

async function loadThanatosSnapshot(name: string): Promise<ThanatosSnapshot> {
  const snapshotDir = join(
    dirname(fileURLToPath(import.meta.url)),
    "thanatosSnapshots",
    name,
  );
  const program = await readFile(join(snapshotDir, "input.ski"), "utf8");
  const resultDagPath = join(snapshotDir, "result.dag");
  const stdinPath = join(snapshotDir, "stdin.bin");
  return {
    dag: toDagWire(parseSKI(program)),
    stdin: await readFile(stdinPath),
    stdinPath,
    stdout: await readFile(join(snapshotDir, "stdout.bin")),
    resultDag: existsSync(resultDagPath)
      ? await readFile(resultDagPath, "utf8")
      : null,
  };
}

function setBrokerEnv(url: string, token: string): () => void {
  const envVarNames = getBatchBrokerEnvVarNames();
  process.env[envVarNames.url] = url;
  process.env[envVarNames.token] = token;
  return () => {
    delete process.env[envVarNames.url];
    delete process.env[envVarNames.token];
  };
}

function mockBrokerTransport() {
  const originalFetch = globalThis.fetch;
  let requestHandler:
    | ((request: Request) => Response | Promise<Response>)
    | null = null;
  let shutdownCalls = 0;

  globalThis.fetch = (async (
    input: Request | URL | string,
    init?: RequestInit,
  ) => {
    if (requestHandler === null) {
      return originalFetch(input, init);
    }
    const request = input instanceof Request ? input : new Request(input, init);
    return await (requestHandler as any)(request);
  }) as typeof fetch;

  return {
    get shutdownCalls(): number {
      return shutdownCalls;
    },
    restore(): void {
      globalThis.fetch = originalFetch;
    },
  };
}

test("thanatos harness helpers cover U8 DAG and passthrough evaluator", async () => {
  const parsed = fromDagWire("#u8(65)");
  assert.equal(parsed.kind, "u8");
  assert.equal((parsed as { kind: "u8"; value: number }).value, 65);
  assert.equal(defaultWorkerCount() >= 2, true);
  assert.deepEqual(await runThanatosBatch([]), []);

  const expr = parseSKI("I");
  const stepped = passthroughEvaluator.stepOnce(expr);
  assert.equal(stepped.altered, false);
  assert.equal(stepped.expr, expr);
  assert.equal(passthroughEvaluator.reduce(expr), expr);
  const reduceAsync = passthroughEvaluator.reduceAsync;
  assert.ok(reduceAsync);
  assert.equal(await reduceAsync(expr), expr);
});

test(
  "thanatos harness direct session covers reduceIo, batching, and shared state",
  { skip: !thanatosAvailable() },
  async () => {
    const snapshot = await loadThanatosSnapshot("readOneA");

    try {
      const first = await getThanatosSession({
        key: "thanatos-unit-shared",
        env: { B: "2", A: "1" },
      });
      const second = await getThanatosSession({
        key: "thanatos-unit-shared",
        env: { A: "1", B: "2" },
      });
      assert.equal(first, second);

      const reduceIoResult = await first.reduceIo(snapshot.dag, snapshot.stdin);
      assert.deepEqual(reduceIoResult.stdout, new Uint8Array(snapshot.stdout));
      assert.equal(
        unparseSKI(fromDagWire(reduceIoResult.resultDag)),
        unparseSKI(fromDagWire(snapshot.resultDag ?? snapshot.dag)),
      );

      assert.deepEqual(await runThanatosBatch(["I K", "K S K"]), ["K", "S"]);

      const noResetValue = await withBatchThanatosSession(
        async (session) => {
          await session.ping();
          return await session.reduceDag(toDagWire(parseSKI("I K")));
        },
        {
          key: "thanatos-unit-no-reset",
          resetBefore: false,
          resetAfter: false,
        },
      );
      assert.equal(unparseSKI(fromDagWire(noResetValue)), "K");
    } finally {
      await closeBatchThanatosSessions();
    }
  },
);

test(
  "thanatos harness broker-backed session covers broker request paths",
  { skip: !thanatosAvailable() },
  async () => {
    const transport = mockBrokerTransport();
    const envVarNames = getBatchBrokerEnvVarNames();
    const snapshot = await loadThanatosSnapshot("readOneA");
    const tempDir = await mkdtemp(join(tmpdir(), "thanatos-test-"));
    const outputPath = join(tempDir, "stdout.bin");
    const traceDir = await mkdtemp(join(tmpdir(), "thanatos-trace-"));

    let brokerUrl = "";
    let brokerToken = "";
    let started:
      | Awaited<ReturnType<typeof startThanatosBatchBroker>>
      | undefined;
    let brokerSession:
      | Awaited<ReturnType<typeof getThanatosSession>>
      | undefined;
    try {
      started = await startThanatosBatchBroker({
        workers: 1,
        env: {
          THANATOS_TRACE_DIR: traceDir,
          THANATOS_TRACE_TIMEOUT_MS: "200",
        },
      });
      brokerUrl = started.env[envVarNames.url]!;
      brokerToken = started.env[envVarNames.token]!;
      const broker = { url: brokerUrl, token: brokerToken };

      {
        const clearBrokerEnv = setBrokerEnv(brokerUrl, brokerToken);
        try {
          assert.ok(usingThanatosBatchBroker());
        } finally {
          clearBrokerEnv();
        }
      }

      const methodNotAllowed = await fetch(brokerUrl, { method: "GET" });
      assert.equal(methodNotAllowed.status, 405);

      const forbidden = await fetch(brokerUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      assert.equal(forbidden.status, 403);

      const malformed = await fetch(brokerUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [BROKER_TOKEN_HEADER]: brokerToken,
        },
        body: "{",
      });
      const malformedBody = (await malformed.json()) as {
        ok: boolean;
        error?: string;
      };
      assert.equal(malformedBody.ok, false);
      assert.equal(malformedBody.error, "Internal error");

      brokerSession = await getThanatosSession({
        key: "thanatos-unit-broker",
        broker,
      });
      brokerSession.start(99, { IGNORED: "1" });
      assert.equal(await brokerSession.rawRequest("PING"), "OK");
      assert.equal(
        unparseSKI(
          fromDagWire(
            await brokerSession.reduceDag(toDagWire(parseSKI("I K"))),
          ),
        ),
        "K",
      );

      const reduceIoResult = await brokerSession.reduceIo(
        snapshot.dag,
        snapshot.stdin,
      );
      assert.deepEqual(reduceIoResult.stdout, new Uint8Array(snapshot.stdout));
      assert.equal(
        unparseSKI(fromDagWire(reduceIoResult.resultDag)),
        unparseSKI(fromDagWire(snapshot.resultDag ?? snapshot.dag)),
      );

      const fileResultDag = await brokerSession.reduceFile(
        snapshot.dag,
        snapshot.stdinPath,
        outputPath,
      );
      assert.deepEqual(await readFile(outputPath), snapshot.stdout);
      assert.equal(
        unparseSKI(fromDagWire(fileResultDag)),
        unparseSKI(fromDagWire(snapshot.resultDag ?? snapshot.dag)),
      );

      await brokerSession.reset();
      await brokerSession.ping();
      assert.ok((await brokerSession.stats()).startsWith("OK "));
      await brokerSession.traceDump();

      {
        const clearBrokerEnv = setBrokerEnv(brokerUrl, brokerToken);
        try {
          await closeBatchThanatosSessions();
          await brokerSession.ping();
        } finally {
          clearBrokerEnv();
        }
      }

      await assert.rejects(() => brokerSession!.reduceDag("INVALID"), {
        message: "Internal error",
      });

      await brokerSession.close();
      await assert.rejects(() => brokerSession!.ping(), {
        message: "ThanatosSession closed",
      });

      await started.close();
      await closeBatchThanatosSessions();
    } finally {
      delete process.env[envVarNames.url];
      delete process.env[envVarNames.token];
      await brokerSession?.close().catch(() => {});
      await started?.close().catch(() => {});
      await closeBatchThanatosSessions();
      await rm(tempDir, { recursive: true, force: true }).catch(() => {});
      await rm(traceDir, { recursive: true, force: true }).catch(() => {});
      transport.restore();
    }

    const envVarNames2 = getBatchBrokerEnvVarNames();
    try {
      const started = await startThanatosBatchBroker({ workers: 1 });
      try {
        const session = await getThanatosSession({
          key: "thanatos-unit-broker-bad-token",
          broker: {
            url: started.env[envVarNames2.url]!,
            token: "not-the-right-token",
          },
        });
        await assert.rejects(() => session.ping(), {
          message: /thanatos broker request failed with status 403/,
        });
      } finally {
        await started.close();
        await closeBatchThanatosSessions();
      }
    } catch (e) {
      // ignore
    }
  },
);
