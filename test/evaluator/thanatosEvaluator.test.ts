import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it } from "../util/test_shim.ts";
import {
  closeBatchThanatosSessions,
  getBatchBrokerEnvVarNames,
  getThanatosSession,
  startThanatosBatchBroker,
} from "../thanatosHarness.ts";
import {
  createThanatosEvaluator,
  createArenaEvaluator,
  ThanatosUnavailableError,
  thanatosAvailable,
} from "../../lib/index.ts";
import { parseSKI } from "../../lib/parser/ski.ts";
import { unparseSKI } from "../../lib/ski/expression.ts";
import { I, WriteOne } from "../../lib/ski/terminal.ts";
import { apply } from "../../lib/ski/expression.ts";

async function withoutBrokerEnv<T>(callback: () => Promise<T>): Promise<T> {
  const env = getBatchBrokerEnvVarNames();
  const oldUrl = process.env[env.url];
  const oldToken = process.env[env.token];
  delete process.env[env.url];
  delete process.env[env.token];
  try {
    return await callback();
  } finally {
    await closeBatchThanatosSessions();
    if (oldUrl === undefined) {
      delete process.env[env.url];
    } else {
      process.env[env.url] = oldUrl;
    }
    if (oldToken === undefined) {
      delete process.env[env.token];
    } else {
      process.env[env.token] = oldToken;
    }
  }
}

it("ThanatosEvaluator reports an absent daemon", async () => {
  const missing = join(tmpdir(), "typed-ski-missing-thanatos");
  await assert.rejects(
    () =>
      withoutBrokerEnv(async () => {
        await createThanatosEvaluator({ binPath: missing });
      }),
    (error) =>
      error instanceof ThanatosUnavailableError &&
      error.message.includes(missing) &&
      error.message.includes("Build //:thanatos"),
  );
});

describe("ThanatosEvaluator", { skip: !thanatosAvailable() }, () => {
  it("reduces a basic expression", async () => {
    const evaluator = await createThanatosEvaluator({ key: "basic" });
    const result = await evaluator.reduce(parseSKI("I K"));
    assert.equal(unparseSKI(result), "K");
  });

  it("keeps createArenaEvaluator as a Thanatos compatibility alias", async () => {
    const evaluator = await createArenaEvaluator({ key: "arena-alias" });
    const result = await evaluator.reduce(parseSKI("I (I K)"));
    assert.equal(unparseSKI(result), "K");
  });

  it("captures REDUCE_IO stdin and stdout", async () => {
    const evaluator = await createThanatosEvaluator({ key: "io" });
    const expr = apply(apply(WriteOne, { kind: "u8", value: 65 }), I);
    const { result, stdout } = await evaluator.reduceWithIo(expr);
    assert.equal(unparseSKI(result), "#u8(65)");
    assert.deepEqual(stdout, new Uint8Array([65]));
  });

  it("reuses direct singleton sessions by key", async () => {
    await withoutBrokerEnv(async () => {
      const first = await getThanatosSession({ key: "same-key", workers: 1 });
      const second = await getThanatosSession({ key: "same-key", workers: 1 });
      assert.equal(first, second);
      await closeBatchThanatosSessions();
    });
  });

  it("uses broker configuration from env", async () => {
    const env = getBatchBrokerEnvVarNames();
    const started = await startThanatosBatchBroker({ workers: 1 });
    const oldUrl = process.env[env.url];
    const oldToken = process.env[env.token];
    try {
      Object.assign(process.env, started.env);
      const evaluator = await createThanatosEvaluator({ key: "broker-env" });
      const result = await evaluator.reduce(parseSKI("I S"));
      assert.equal(unparseSKI(result), "S");
    } finally {
      if (oldUrl === undefined) {
        delete process.env[env.url];
      } else {
        process.env[env.url] = oldUrl;
      }
      if (oldToken === undefined) {
        delete process.env[env.token];
      } else {
        process.env[env.token] = oldToken;
      }
      await started.close();
    }
  });

  it("converts daemon errors to JavaScript errors", async () => {
    await withoutBrokerEnv(async () => {
      const session = await getThanatosSession({ key: "daemon-error" });
      await assert.rejects(() => session.reduceDag("INVALID"), {
        message: "thanatos: parse error",
      });
    });
  });

  it("times out a stalled request and clears the singleton", async () => {
    await withoutBrokerEnv(async () => {
      const options = {
        key: "timeout",
        workers: 1,
        requestTimeoutMs: 1,
      };
      const evaluator = await createThanatosEvaluator(options);
      await assert.rejects(
        () => evaluator.reduce(parseSKI("I K")),
        /thanatos request timed out/,
      );

      const fresh = await createThanatosEvaluator({
        ...options,
        requestTimeoutMs: 60000,
      });
      const result = await fresh.reduce(parseSKI("I K"));
      assert.equal(unparseSKI(result), "K");
    });
  });
});
