import { describe, it } from "./util/test_shim.ts";
import assert from "node:assert/strict";
import { createThanatosEvaluator, thanatosAvailable } from "../lib/index.ts";
import { linkModules } from "../lib/linker/moduleLinker.ts";
import { parseSKI } from "../lib/parser/ski.ts";
import { getBinObject } from "../lib/bin.ts";
import { getPreludeObject } from "../lib/prelude.ts";
import { getNatObject } from "../lib/nat.ts";
import { UnChurchNumber } from "../lib/ski/church.ts";
import { loadTripModuleObject } from "../lib/tripSourceLoader.ts";

it(
  "links prelude with not, and, or, pred, sub, lte, gte",
  { skip: !thanatosAvailable() },
  async () => {
    const preludeObject = await getPreludeObject();
    const binObject = await getBinObject();
    const natObject = await getNatObject();
    const testObject = await loadTripModuleObject(
      new URL("./compiler/inputs/preludeTest.trip", import.meta.url),
    );

    const skiExpression = linkModules(
      [
        { name: "Prelude", object: preludeObject },
        { name: "Bin", object: binObject },
        { name: "Nat", object: natObject },
        { name: "TestPrelude", object: testObject },
      ],
      true,
    );

    const skiExpr = parseSKI(skiExpression);
    const evaluator = await createThanatosEvaluator();
    try {
      const evaluated = await evaluator.reduce(skiExpr);
      const decoded = await UnChurchNumber(evaluated, evaluator);
      assert.deepStrictEqual(
        decoded,
        8n,
        "not/and/or/pred/sub/lte/gte expressions should sum to 8",
      );
    } finally {
      await evaluator.terminate();
    }
  },
);

it("subU8 primitive subtraction", { skip: !thanatosAvailable() }, async () => {
  const preludeObject = await getPreludeObject();
  const testObject = await loadTripModuleObject(
    new URL("./compiler/inputs/subU8Test.trip", import.meta.url),
  );

  const skiExpression = linkModules(
    [
      { name: "Prelude", object: preludeObject },
      { name: "SubU8Test", object: testObject },
    ],
    true,
  );

  const skiExpr = parseSKI(skiExpression);
  const evaluator = await createThanatosEvaluator();
  try {
    const result = await evaluator.reduce(skiExpr);
    assert.deepStrictEqual(
      result,
      { kind: "u8", value: 8 },
      "subU8 #u8(10) #u8(2) should be #u8(8)",
    );
  } finally {
    await evaluator.terminate();
  }
});
