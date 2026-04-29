import {
  strictEqual as assertEquals,
  ok as assertOk,
} from "node:assert/strict";
import { describe, it } from "./util/test_shim.ts";
import { AVL_CASES } from "./avlCases.ts";
import {
  expectedAvlMiniCoreNat,
  runAvlMiniCoreCase,
} from "./avlMiniCoreHarness.ts";

describe("AVL module tests (MiniCore)", () => {
  for (const testCase of AVL_CASES) {
    it(`AVL module ${testCase.name} (MiniCore)`, async () => {
      const result = await runAvlMiniCoreCase(testCase);
      assertEquals(result.actual, expectedAvlMiniCoreNat(testCase));
      assertOk(
        result.telemetry.caseDispatches > 0,
        "MiniCore AVL run should exercise direct case dispatch",
      );
    });
  }
});
