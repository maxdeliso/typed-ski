import { assert, assertEquals, assertRejects } from "std/assert";
import { existsSync } from "std/fs";
import { dirname, fromFileUrl, join } from "std/path";
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
  stdout: Uint8Array;
  resultDag: string | null;
};

async function loadThanatosSnapshot(name: string): Promise<ThanatosSnapshot> {
  const snapshotDir = join(
    dirname(fromFileUrl(import.meta.url)),
    "thanatosSnapshots",
    name,
  );
  const program = await Deno.readTextFile(join(snapshotDir, "input.ski"));
  const resultDagPath = join(snapshotDir, "result.dag");
  return {
    dag: toDagWire(parseSKI(program)),
    stdin: await Deno.readFile(join(snapshotDir, "stdin.bin")),
    stdout: await Deno.readFile(join(snapshotDir, "stdout.bin")),
    resultDag: existsSync(resultDagPath)
      ? await Deno.readTextFile(resultDagPath)
      : null,
  };
}

function setBrokerEnv(url: string, token: string): () => void {
  const envVarNames = getBatchBrokerEnvVarNames();
  Deno.env.set(envVarNames.url, url);
  Deno.env.set(envVarNames.token, token);
  return () => {
    Deno.env.delete(envVarNames.url);
    Deno.env.delete(envVarNames.token);
  };
}

function mockBrokerTransport() {
  const originalServe = Deno.serve;
  const originalFetch = globalThis.fetch;
  let requestHandler:
    | ((request: Request) => Response | Promise<Response>)
    | null = null;
  let shutdownCalls = 0;

  Object.defineProperty(Deno, "serve", {
    configurable: true,
    value: (
      _options: Deno.ServeTcpOptions,
      handler: (request: Request) => Response | Promise<Response>,
    ) => {
      requestHandler = handler;
      const finished = Promise.reject(new Error("broker finished"));
      void finished.catch(() => {});
      return {
        addr: {
          hostname: "127.0.0.1",
          port: 43123,
          transport: "tcp",
        },
        shutdown: () => {
          shutdownCalls++;
        },
        finished,
      };
    },
  });

  globalThis.fetch = ((input: Request | URL | string, init?: RequestInit) => {
    if (requestHandler === null) {
      throw new Error("broker request handler not registered");
    }
    const request = input instanceof Request ? input : new Request(input, init);
    return Promise.resolve(requestHandler(request));
  }) as typeof fetch;

  return {
    get shutdownCalls(): number {
      return shutdownCalls;
    },
    restore(): void {
      Object.defineProperty(Deno, "serve", {
        configurable: true,
        value: originalServe,
      });
      globalThis.fetch = originalFetch;
    },
  };
}

Deno.test("thanatos harness helpers cover U8 DAG and passthrough evaluator", async () => {
  const parsed = fromDagWire("#u8(65)");
  assertEquals(parsed.kind, "u8");
  assertEquals((parsed as { kind: "u8"; value: number }).value, 65);
  assertEquals(defaultWorkerCount() >= 2, true);
  assertEquals(await runThanatosBatch([]), []);

  const expr = parseSKI("I");
  const stepped = passthroughEvaluator.stepOnce(expr);
  assertEquals(stepped.altered, false);
  assertEquals(stepped.expr, expr);
  assertEquals(passthroughEvaluator.reduce(expr), expr);
  const reduceAsync = passthroughEvaluator.reduceAsync;
  assert(reduceAsync);
  assertEquals(await reduceAsync(expr), expr);
});

Deno.test({
  name:
    "thanatos harness direct session covers reduceIo, batching, and shared state",
  ignore: !thanatosAvailable(),
  fn: async () => {
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
      assertEquals(first, second);

      const reduceIoResult = await first.reduceIo(snapshot.dag, snapshot.stdin);
      assertEquals(reduceIoResult.stdout, snapshot.stdout);
      assertEquals(
        unparseSKI(fromDagWire(reduceIoResult.resultDag)),
        unparseSKI(fromDagWire(snapshot.resultDag ?? snapshot.dag)),
      );

      assertEquals(
        await runThanatosBatch(["I K", "K S K"]),
        ["K", "S"],
      );

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
      assertEquals(unparseSKI(fromDagWire(noResetValue)), "K");
    } finally {
      await closeBatchThanatosSessions();
    }
  },
});

Deno.test({
  name: "thanatos harness broker-backed session covers broker request paths",
  ignore: !thanatosAvailable(),
  fn: async () => {
    const transport = mockBrokerTransport();
    const envVarNames = getBatchBrokerEnvVarNames();
    const snapshot = await loadThanatosSnapshot("readOneA");
    const tempDir = await Deno.makeTempDir();
    const inputPath = join(tempDir, "stdin.bin");
    const outputPath = join(tempDir, "stdout.bin");
    const traceDir = await Deno.makeTempDir();

    let brokerUrl = "";
    let brokerToken = "";
    try {
      const started = await startThanatosBatchBroker({
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
          assert(usingThanatosBatchBroker());
        } finally {
          clearBrokerEnv();
        }
      }

      const methodNotAllowed = await fetch(brokerUrl, { method: "GET" });
      assertEquals(methodNotAllowed.status, 405);

      const forbidden = await fetch(brokerUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      assertEquals(forbidden.status, 403);

      const malformed = await fetch(brokerUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [BROKER_TOKEN_HEADER]: brokerToken,
        },
        body: "{",
      });
      const malformedBody = await malformed.json() as {
        ok: boolean;
        error?: string;
      };
      assertEquals(malformedBody.ok, false);
      assertEquals(malformedBody.error, "Internal error");

      const brokerSession = await getThanatosSession({
        key: "thanatos-unit-broker",
        broker,
      });
      brokerSession.start(99, { IGNORED: "1" });
      assertEquals(await brokerSession.rawRequest("PING"), "OK");
      assertEquals(
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
      assertEquals(reduceIoResult.stdout, snapshot.stdout);
      assertEquals(
        unparseSKI(fromDagWire(reduceIoResult.resultDag)),
        unparseSKI(fromDagWire(snapshot.resultDag ?? snapshot.dag)),
      );

      await Deno.writeFile(inputPath, snapshot.stdin);
      const fileResultDag = await brokerSession.reduceFile(
        snapshot.dag,
        inputPath,
        outputPath,
      );
      assertEquals(await Deno.readFile(outputPath), snapshot.stdout);
      assertEquals(
        unparseSKI(fromDagWire(fileResultDag)),
        unparseSKI(fromDagWire(snapshot.resultDag ?? snapshot.dag)),
      );

      await brokerSession.reset();
      await brokerSession.ping();
      assert((await brokerSession.stats()).startsWith("OK "));
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

      await assertRejects(
        () => brokerSession.reduceDag("INVALID"),
        Error,
        "Internal error",
      );

      await brokerSession.close();
      await assertRejects(
        () => brokerSession.ping(),
        Error,
        "ThanatosSession closed",
      );

      await started.close();
      await closeBatchThanatosSessions();
      assertEquals(transport.shutdownCalls, 1);
    } finally {
      Deno.env.delete(envVarNames.url);
      Deno.env.delete(envVarNames.token);
      await closeBatchThanatosSessions();
      await Deno.remove(tempDir, { recursive: true }).catch(() => {});
      await Deno.remove(traceDir, { recursive: true }).catch(() => {});
      transport.restore();
    }

    const secondTransport = mockBrokerTransport();
    try {
      const started = await startThanatosBatchBroker({ workers: 1 });
      try {
        const session = await getThanatosSession({
          key: "thanatos-unit-broker-bad-token",
          broker: {
            url: started.env[envVarNames.url]!,
            token: "not-the-right-token",
          },
        });
        await assertRejects(
          () => session.ping(),
          Error,
          "thanatos broker request failed with status 403",
        );
      } finally {
        await started.close();
        await closeBatchThanatosSessions();
      }
    } finally {
      secondTransport.restore();
    }
  },
});
