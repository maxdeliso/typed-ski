import { describe, it } from "../util/test_shim.ts";
/**
 * Linker tests for prelude list operations
 */

import assert from "node:assert/strict";
import { join } from "node:path";
import { workspaceRoot } from "../../lib/shared/workspaceRoot.ts";
import { linkModules } from "../../lib/linker/moduleLinker.ts";
import { getBinObject } from "../../lib/bin.ts";
import { getPreludeObject } from "../../lib/prelude.ts";
import { getNatObject } from "../../lib/nat.ts";
import { parseSKI } from "../../lib/parser/ski.ts";
import { UnChurchBoolean, UnChurchNumber } from "../../lib/ski/church.ts";
import {
  closeBatchThanatosSessions,
  passthroughEvaluator,
  runThanatosBatch,
  thanatosAvailable,
} from "../thanatosHarness.ts";
import { loadTripModuleObject } from "../../lib/tripSourceLoader.ts";

describe("Prelude List Linking", () => {
  it(
    "links prelude list cases (thanatos)",
    {
      skip: !thanatosAvailable(),
    },
    async () => {
      try {
        const preludeObj = await getPreludeObject();
        const binObj = await getBinObject();
        const natObj = await getNatObject();
        const testObj = await loadTripModuleObject(
          join(workspaceRoot, "test", "linker", "inputs", "testLists.trip"),
        );

        const skiExpression = linkModules([
          { name: "Prelude", object: preludeObj },
          { name: "Bin", object: binObj },
          { name: "Nat", object: natObj },
          { name: "Test", object: testObj },
        ]);

        const results = await runThanatosBatch([skiExpression]);
        const result = results[0];
        assert.notStrictEqual(result, undefined);

        const decoded = await UnChurchNumber(
          parseSKI(result!),
          passthroughEvaluator,
        );
        assert.strictEqual(decoded, 6n); // sum [1, 2, 3]
      } finally {
        await closeBatchThanatosSessions();
      }
    },
  );
});
