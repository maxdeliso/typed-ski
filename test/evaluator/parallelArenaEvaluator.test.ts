import { after, describe, it } from "../util/test_shim.ts";
import assert from "node:assert/strict";
import { parseSKI } from "../../lib/parser/ski.ts";
import { unparseSKI } from "../../lib/ski/expression.ts";
import { fromTopoDagWire } from "../../lib/ski/topoDagWire.ts";
import {
  closeBatchThanatosSessions,
  withBatchThanatosSession,
} from "../thanatosHarness.ts";
import { thanatosAvailable } from "../thanatosHarness/config.ts";

async function reduceWithThanatos(
  expr: string,
  key: string,
  workers = 4,
): Promise<string> {
  return await withBatchThanatosSession(
    async (session) => {
      const resultDag = await session.reduceExpr(parseSKI(expr));
      return unparseSKI(fromTopoDagWire(resultDag));
    },
    { key, workers },
  );
}

after(async () => {
  await closeBatchThanatosSessions();
});

describe("Thanatos regression coverage", { skip: !thanatosAvailable() }, () => {
  it("reduces a basic expression", async () => {
    assert.strictEqual(await reduceWithThanatos("I K", "thanatos-basic"), "K");
  });

  it("reduces many expressions correctly with a multi-worker runtime", async () => {
    const results = await withBatchThanatosSession(
      async (session) => {
        const out: string[] = [];
        for (let i = 0; i < 32; i++) {
          const expr = parseSKI(i % 2 === 0 ? "I K" : "I S");
          const resultDag = await session.reduceExpr(expr);
          out.push(unparseSKI(fromTopoDagWire(resultDag)));
        }
        return out;
      },
      { key: "thanatos-many", workers: 4 },
    );

    results.forEach((result, i) => {
      assert.strictEqual(result, i % 2 === 0 ? "K" : "S");
    });
  });

  it("preserves results across concurrent independent sessions", async () => {
    const results = await Promise.all([
      reduceWithThanatos("I K", "thanatos-concurrent-1"),
      reduceWithThanatos("I S", "thanatos-concurrent-2"),
      reduceWithThanatos("K S I", "thanatos-concurrent-3"),
    ]);

    assert.deepStrictEqual(results, ["K", "S", "S"]);
  });
});
