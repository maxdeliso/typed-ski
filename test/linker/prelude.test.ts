import { test } from "node:test";
/**
 * Tests for the TripLang Linker prelude integration
 */

import { expect } from "../util/assertions.ts";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deserializeTripCObject } from "../../lib/compiler/objectFile.ts";
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

const __dirname = dirname(fileURLToPath(import.meta.url));

test("Prelude Linking", async (t) => {
  await t.test(
    "links prelude arithmetic cases (thanatos)",
    {
      skip: !thanatosAvailable(),
    },
    async () => {
      try {
        const preludeObj = await getPreludeObject();
        const binObj = await getBinObject();
        const natObj = await getNatObject();
        const testObj = await loadTripModuleObject(
          join(__dirname, "inputs", "testArithmetic.trip"),
        );

        const skiExpression = linkModules([
          { name: "Prelude", object: preludeObj },
          { name: "Bin", object: binObj },
          { name: "Nat", object: natObj },
          { name: "Test", object: testObj },
        ]);

        const results = await runThanatosBatch([skiExpression]);
        const result = results[0];
        expect(result).to.not.be.undefined;

        const decoded = await UnChurchNumber(
          parseSKI(result!),
          passthroughEvaluator,
        );
        expect(decoded).to.equal(5n); // 2 + 3
      } finally {
        await closeBatchThanatosSessions();
      }
    },
  );

  await t.test(
    "links prelude logic cases (thanatos)",
    {
      skip: !thanatosAvailable(),
    },
    async () => {
      try {
        const preludeObj = await getPreludeObject();
        const testObj = await loadTripModuleObject(
          join(__dirname, "inputs", "testLogic.trip"),
        );

        const skiExpression = linkModules([
          { name: "Prelude", object: preludeObj },
          { name: "Test", object: testObj },
        ]);

        const results = await runThanatosBatch([skiExpression]);
        const result = results[0];
        expect(result).to.not.be.undefined;

        const decoded = await UnChurchBoolean(
          parseSKI(result!),
          passthroughEvaluator,
        );
        expect(decoded).to.be.true; // true && (false || true)
      } finally {
        await closeBatchThanatosSessions();
      }
    },
  );
});
