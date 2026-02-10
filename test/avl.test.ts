import { assertEquals } from "std/assert";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compileToObjectFileString } from "../lib/compiler/index.ts";
import { deserializeTripCObject } from "../lib/compiler/objectFile.ts";
import { ParallelArenaEvaluatorWasm } from "../lib/evaluator/parallelArenaEvaluator.ts";
import { linkModules } from "../lib/linker/moduleLinker.ts";
import { getAvlObject } from "../lib/avl.ts";
import { getNatObject } from "../lib/nat.ts";
import { parseSKI } from "../lib/parser/ski.ts";
import { getPreludeObject } from "../lib/prelude.ts";
import type { SKIExpression } from "../lib/ski/expression.ts";
import { UnChurchNumber } from "../lib/ski/church.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const INPUT_DIR = join(__dirname, "inputs", "avl");

type AvlCase = { name: string; fileName: string };

const AVL_CASES: AvlCase[] = [
  { name: "AvlNatTreeTest", fileName: "AvlNatTreeTest.trip" },
  { name: "AvlBinBoolTreeTest", fileName: "AvlBinBoolTreeTest.trip" },
  { name: "AvlInsertTraversalTest", fileName: "AvlInsertTraversalTest.trip" },
  { name: "AvlDeleteTraversalTest", fileName: "AvlDeleteTraversalTest.trip" },
];

async function loadInput(fileName: string): Promise<string> {
  return await Deno.readTextFile(join(INPUT_DIR, fileName));
}

async function buildTestExpression(
  source: string,
  moduleName: string,
): Promise<SKIExpression> {
  const preludeObject = await getPreludeObject();
  const natObject = await getNatObject();
  const avlObject = await getAvlObject();
  const serialized = compileToObjectFileString(source);
  const testObject = deserializeTripCObject(serialized);

  const skiExpression = linkModules([
    { name: "Prelude", object: preludeObject },
    { name: "Nat", object: natObject },
    { name: "Avl", object: avlObject },
    { name: moduleName, object: testObject },
  ], true);

  return parseSKI(skiExpression);
}

async function evaluateTestModulesBatch(
  modules: Array<{ name: string; fileName: string }>,
): Promise<Map<string, bigint>> {
  const expressions = await Promise.all(
    modules.map(async ({ name, fileName }) => ({
      name,
      expr: await buildTestExpression(await loadInput(fileName), name),
    })),
  );

  const reduced = await Promise.all(
    expressions.map(async ({ name, expr }) => {
      const evaluator = await ParallelArenaEvaluatorWasm.create();
      try {
        const evaluated = await evaluator.reduceAsync(expr);
        return [name, UnChurchNumber(evaluated)] as const;
      } finally {
        evaluator.terminate();
      }
    }),
  );
  return new Map<string, bigint>(reduced);
}

Deno.test("Avl module tests (batched)", async () => {
  const results = await evaluateTestModulesBatch(AVL_CASES);

  assertEquals(results.get("AvlNatTreeTest"), 12n);
  assertEquals(results.get("AvlBinBoolTreeTest"), 9n);
  assertEquals(results.get("AvlInsertTraversalTest"), 321n);
  assertEquals(results.get("AvlDeleteTraversalTest"), 36n);
});
