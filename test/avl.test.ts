import { assertEquals } from "std/assert";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compileToObjectFileString } from "../lib/compiler/index.ts";
import { deserializeTripCObject } from "../lib/compiler/objectFile.ts";
import { linkModules } from "../lib/linker/moduleLinker.ts";
import { getAvlObject } from "./util/avl.ts";
import { getBinObject } from "../lib/bin.ts";
import { getNatObject } from "../lib/nat.ts";
import { parseSKI } from "../lib/parser/ski.ts";
import { getPreludeObject } from "../lib/prelude.ts";
import type { SKIExpression } from "../lib/ski/expression.ts";
import { unparseSKI } from "../lib/ski/expression.ts";
import { UnChurchNumber } from "../lib/ski/church.ts";
import {
  passthroughEvaluator,
  runThanatosBatch,
  thanatosAvailable,
} from "./thanatosHarness.test.ts";

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
  const binObject = await getBinObject();
  const natObject = await getNatObject();
  const avlObject = await getAvlObject();
  const serialized = compileToObjectFileString(source);
  const testObject = deserializeTripCObject(serialized);

  const skiExpression = linkModules([
    { name: "Prelude", object: preludeObject },
    { name: "Bin", object: binObject },
    { name: "Nat", object: natObject },
    { name: "Avl", object: avlObject },
    { name: moduleName, object: testObject },
  ]);

  return parseSKI(skiExpression);
}

/**
 * Run the same AVL test cases via thanatos batch mode: build all expressions,
 * run one batch (one process, all lines on stdin), then decode results.
 */
async function evaluateTestModulesBatchThanatos(
  modules: Array<{ name: string; fileName: string }>,
): Promise<Map<string, bigint>> {
  const inputs: string[] = [];
  for (const { name, fileName } of modules) {
    const source = await loadInput(fileName);
    const expr = await buildTestExpression(source, name);
    inputs.push(unparseSKI(expr));
  }
  const lines = await runThanatosBatch(inputs);
  const results = new Map<string, bigint>();
  for (let i = 0; i < modules.length; i++) {
    const name = modules[i]!.name;
    const line = lines[i] ?? "";
    if (line === "") {
      results.set(name, 0n);
      continue;
    }
    try {
      const parsed = parseSKI(line);
      results.set(name, await UnChurchNumber(parsed, passthroughEvaluator));
    } catch {
      results.set(name, 0n);
    }
  }
  return results;
}

Deno.test("thanatosHarness runThanatosBatch empty input", async () => {
  assertEquals(await runThanatosBatch([]), []);
});

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
