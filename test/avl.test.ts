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
import { unparseSKI } from "../lib/ski/expression.ts";
import { UnChurchNumber } from "../lib/ski/church.ts";
import {
  passthroughEvaluator,
  runThanatosBatch,
  runThanatosOne,
  thanatosAvailable,
} from "./thanatosHarness.ts";

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
  ], false);

  return parseSKI(skiExpression);
}

async function evaluateTestModulesBatch(
  modules: Array<{ name: string; fileName: string }>,
): Promise<Map<string, bigint>> {
  const results = new Map<string, bigint>();
  const evaluator = await ParallelArenaEvaluatorWasm.create();

  try {
    for (const { name, fileName } of modules) {
      const source = await loadInput(fileName);
      const expr = await buildTestExpression(source, name);
      const evaluated = await evaluator.reduceAsync(expr);
      const val = await UnChurchNumber(evaluated, evaluator);
      results.set(name, val);
    }
  } finally {
    evaluator.terminate();
  }

  return results;
}

/**
 * Run the same AVL test cases via native thanatos: TypeScript builds the SKI expression
 * and serializes to skipqr; we spawn ./bin/thanatos per expression, feed one line on stdin,
 * block for one line on stdout, then parse and assert.
 */
async function evaluateTestModulesBatchThanatos(
  modules: Array<{ name: string; fileName: string }>,
): Promise<Map<string, bigint>> {
  const results = new Map<string, bigint>();

  for (const { name, fileName } of modules) {
    const source = await loadInput(fileName);
    const expr = await buildTestExpression(source, name);
    const line = await runThanatosOne(unparseSKI(expr));
    if (line === "") {
      results.set(name, 0n);
      continue;
    }
    try {
      const parsed = parseSKI(line);
      const val = await UnChurchNumber(parsed, passthroughEvaluator);
      results.set(name, val);
    } catch {
      results.set(name, 0n);
    }
  }

  return results;
}

Deno.test("thanatosHarness runThanatosBatch empty input", async () => {
  assertEquals(await runThanatosBatch([]), []);
});

Deno.test(
  {
    name: "Avl module tests (batched)",
    ignore: thanatosAvailable(),
    fn: async () => {
      const results = await evaluateTestModulesBatch(AVL_CASES);

      assertEquals(results.get("AvlNatTreeTest"), 12n);
      assertEquals(results.get("AvlBinBoolTreeTest"), 9n);
      assertEquals(results.get("AvlInsertTraversalTest"), 321n);
      assertEquals(results.get("AvlDeleteTraversalTest"), 36n);
    },
  },
);

Deno.test({
  name: "Avl module tests (batched, thanatos)",
  ignore: !thanatosAvailable(),
  fn: async () => {
    const results = await evaluateTestModulesBatchThanatos(AVL_CASES);

    assertEquals(results.get("AvlNatTreeTest"), 12n);
    assertEquals(results.get("AvlBinBoolTreeTest"), 9n);
    assertEquals(results.get("AvlInsertTraversalTest"), 321n);
    assertEquals(results.get("AvlDeleteTraversalTest"), 36n);
  },
});
