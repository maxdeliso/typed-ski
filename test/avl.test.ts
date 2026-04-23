import {
  strictEqual as assertEquals,
  deepStrictEqual,
} from "node:assert/strict";
import { describe, it } from "./util/test_shim.ts";
import { UnChurchNumber } from "../lib/ski/church.ts";
import { fromTopoDagWire, toTopoDagWire } from "../lib/ski/topoDagWire.ts";
import {
  closeBatchThanatosSessions,
  passthroughEvaluator,
  runThanatosBatch,
  thanatosAvailable,
  withBatchThanatosSession,
} from "./thanatosHarness.ts";
import {
  AVL_CASES,
  buildAvlTestExpression,
  type AvlCase,
} from "./avlHarness.ts";

async function evaluateTestModuleThanatos(testCase: AvlCase): Promise<bigint> {
  const source = await testCase.loadSource();
  const expr = await buildAvlTestExpression(source, testCase.moduleName);
  return await withBatchThanatosSession(async (session) => {
    const resultDag = await session.reduceDag(toTopoDagWire(expr));
    return await UnChurchNumber(
      fromTopoDagWire(resultDag),
      passthroughEvaluator,
    );
  });
}

describe("AVL module tests", () => {
  it("thanatosHarness runThanatosBatch empty input", async () => {
    deepStrictEqual(await runThanatosBatch([]), []);
  });

  for (const testCase of AVL_CASES) {
    it(
      `AVL module ${testCase.name} (thanatos)`,
      { skip: !thanatosAvailable() },
      async () => {
        try {
          const actual = await evaluateTestModuleThanatos(testCase);
          assertEquals(actual, testCase.expected);
        } finally {
          await closeBatchThanatosSessions();
        }
      },
    );
  }
});
