import { assertEquals } from "std/assert";
import { ParallelArenaEvaluatorWasm } from "../lib/evaluator/parallelArenaEvaluator.ts";
import { linkModules } from "../lib/linker/moduleLinker.ts";
import { parseSKI } from "../lib/parser/ski.ts";
import { getBinObject } from "../lib/bin.ts";
import { getPreludeObject } from "../lib/prelude.ts";
import { getNatObject } from "../lib/nat.ts";
import { UnChurchNumber } from "../lib/ski/church.ts";
import { loadTripModuleObject } from "../lib/tripSourceLoader.ts";

Deno.test("links prelude with not, and, or, pred, sub, lte, gte", async () => {
  const preludeObject = await getPreludeObject();
  const binObject = await getBinObject();
  const natObject = await getNatObject();
  const testObject = await loadTripModuleObject(
    new URL("./compiler/inputs/preludeTest.trip", import.meta.url),
  );

  const skiExpression = linkModules([
    { name: "Prelude", object: preludeObject },
    { name: "Bin", object: binObject },
    { name: "Nat", object: natObject },
    { name: "TestPrelude", object: testObject },
  ], true);

  const skiExpr = parseSKI(skiExpression);
  const evaluator = await ParallelArenaEvaluatorWasm.create();
  try {
    const evaluated = await evaluator.reduceAsync(skiExpr);
    const decoded = await UnChurchNumber(evaluated, evaluator);
    assertEquals(
      decoded,
      8n,
      "not/and/or/pred/sub/lte/gte expressions should sum to 8",
    );
  } finally {
    evaluator.terminate();
  }
});

Deno.test("subU8 primitive subtraction", async () => {
  const preludeObject = await getPreludeObject();
  const testObject = await loadTripModuleObject(
    new URL("./compiler/inputs/subU8Test.trip", import.meta.url),
  );

  const skiExpression = linkModules([
    { name: "Prelude", object: preludeObject },
    { name: "SubU8Test", object: testObject },
  ], true);

  const skiExpr = parseSKI(skiExpression);
  const evaluator = await ParallelArenaEvaluatorWasm.create();
  try {
    const evaluated = await evaluator.reduceAsync(skiExpr);
    // fromArena for a U8 should give { kind: "u8", value: number }
    const result = evaluator.fromArena(evaluator.toArena(evaluated));
    assertEquals(
      result,
      { kind: "u8", value: 8 },
      "subU8 #u8(10) #u8(2) should be #u8(8)",
    );
  } finally {
    evaluator.terminate();
  }
});
