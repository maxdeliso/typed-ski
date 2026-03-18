import { assertEquals, assertThrows } from "std/assert";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { linkModules } from "../../lib/linker/moduleLinker.ts";
import { ParallelArenaEvaluatorWasm } from "../../lib/evaluator/parallelArenaEvaluator.ts";
import { UnChurchNumber } from "../../lib/ski/church.ts";
import { parseSKI } from "../../lib/parser/ski.ts";
import { getBinObject } from "../../lib/bin.ts";
import { getPreludeObject } from "../../lib/prelude.ts";
import { getNatObject } from "../../lib/nat.ts";
import type { SKIExpression } from "../../lib/ski/expression.ts";
import { unparseSKI } from "../../lib/ski/expression.ts";
import { loadTripModuleObject } from "../../lib/tripSourceLoader.ts";
import {
  passthroughEvaluator,
  runThanatosBatch,
  thanatosAvailable,
} from "../thanatosHarness.test.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

interface ArithmeticCase {
  key: string;
  testFileName: string;
  moduleName: string;
}

const ARITHMETIC_CASES: ArithmeticCase[] = [
  {
    key: "basic",
    testFileName: "inputs/preludeArithmetic.trip",
    moduleName: "TestArithmetic",
  },
  {
    key: "simple",
    testFileName: "inputs/preludeSimple.trip",
    moduleName: "TestSimple",
  },
  {
    key: "multiplication",
    testFileName: "inputs/preludeMult.trip",
    moduleName: "TestMultiplication",
  },
  {
    key: "complex",
    testFileName: "inputs/preludeComplex.trip",
    moduleName: "TestComplexArithmetic",
  },
];

async function evaluateExpressionsBatch(
  items: Array<{ key: string; expr: SKIExpression }>,
): Promise<Map<string, bigint>> {
  const evaluator = await ParallelArenaEvaluatorWasm.create();
  try {
    const reduced = await Promise.all(
      items.map(async ({ key, expr }) => {
        const arenaMode = (evaluator as unknown as {
          $?: { getArenaMode?: () => number };
        }).$?.getArenaMode?.();
        assertEquals(
          arenaMode,
          1,
          "Prelude linker batch tests must run in shared-memory (multithreaded) arena mode",
        );
        const evaluated = await evaluator.reduceAsync(expr);
        return [key, await UnChurchNumber(evaluated, evaluator)] as const;
      }),
    );
    return new Map(reduced);
  } finally {
    evaluator.terminate();
  }
}

async function runArithmeticBatch(): Promise<Map<string, bigint>> {
  const preludeObject = await getPreludeObject();
  const binObject = await getBinObject();
  const natObject = await getNatObject();

  const expressions: Array<{ key: string; expr: SKIExpression }> = [];
  for (const testCase of ARITHMETIC_CASES) {
    const testObject = await loadTripModuleObject(
      join(__dirname, testCase.testFileName),
    );
    const skiExpression = linkModules([
      { name: "Prelude", object: preludeObject },
      { name: "Bin", object: binObject },
      { name: "Nat", object: natObject },
      { name: testCase.moduleName, object: testObject },
    ], false);
    expressions.push({ key: testCase.key, expr: parseSKI(skiExpression) });
  }

  return await evaluateExpressionsBatch(expressions);
}

/** Same four arithmetic cases, reduced by baremetal thanatos (one batch, shared process). */
async function runArithmeticBatchThanatos(): Promise<Map<string, bigint>> {
  const preludeObject = await getPreludeObject();
  const binObject = await getBinObject();
  const natObject = await getNatObject();
  const results = new Map<string, bigint>();

  const inputs: string[] = [];
  const keys: string[] = [];
  for (const testCase of ARITHMETIC_CASES) {
    const testObject = await loadTripModuleObject(
      join(__dirname, testCase.testFileName),
    );
    const skiExpression = linkModules([
      { name: "Prelude", object: preludeObject },
      { name: "Bin", object: binObject },
      { name: "Nat", object: natObject },
      { name: testCase.moduleName, object: testObject },
    ], false);
    inputs.push(unparseSKI(parseSKI(skiExpression)));
    keys.push(testCase.key);
  }

  const lines = await runThanatosBatch(inputs);
  for (let i = 0; i < keys.length; i++) {
    const line = lines[i] ?? "";
    if (line === "") {
      results.set(keys[i]!, 0n);
      continue;
    }
    try {
      const parsed = parseSKI(line);
      results.set(keys[i]!, await UnChurchNumber(parsed, passthroughEvaluator));
    } catch {
      results.set(keys[i]!, 0n);
    }
  }
  return results;
}

Deno.test({
  name: "links prelude arithmetic cases (batched)",
  ignore: thanatosAvailable(),
  fn: async () => {
    const results = await runArithmeticBatch();

    const basic = results.get("basic");
    const simple = results.get("simple");
    const multiplication = results.get("multiplication");
    const complex = results.get("complex");

    assertEquals(basic, 6n, "mul two three should equal 6");
    assertEquals(simple, 2n, "add one one should equal 2");
    assertEquals(multiplication, 6n, "mul two three should equal 6");
    // (2 * 3) + (1 * 4) = 6 + 4 = 10
    assertEquals(complex, 10n, "Complex arithmetic should equal 10");
  },
});

Deno.test({
  name: "links prelude arithmetic cases (thanatos)",
  ignore: !thanatosAvailable(),
  fn: async () => {
    const results = await runArithmeticBatchThanatos();
    assertEquals(results.get("basic"), 6n, "mul two three should equal 6");
    assertEquals(results.get("simple"), 2n, "add one one should equal 2");
    assertEquals(
      results.get("multiplication"),
      6n,
      "mul two three should equal 6",
    );
    assertEquals(
      results.get("complex"),
      10n,
      "Complex arithmetic should equal 10",
    );
  },
});

Deno.test("links numeric literals across modules without leaking Nat", async () => {
  const preludeObject = await getPreludeObject();
  const binObject = await getBinObject();
  const natObject = await getNatObject();

  const providerFileName = "inputs/preludeLiteralProvider.trip";
  const consumerFileName = "inputs/preludeLiteralConsumer.trip";

  const providerObject = await loadTripModuleObject(
    join(__dirname, providerFileName),
  );
  const consumerObject = await loadTripModuleObject(
    join(__dirname, consumerFileName),
  );

  const skiExpression = linkModules([
    { name: "Prelude", object: preludeObject },
    { name: "Bin", object: binObject },
    { name: "Nat", object: natObject },
    { name: "LiteralProvider", object: providerObject },
    { name: "LiteralConsumer", object: consumerObject },
  ], false);

  const skiExpr = parseSKI(skiExpression);
  const evaluator = await ParallelArenaEvaluatorWasm.create();
  try {
    const arenaMode = (evaluator as unknown as {
      $?: { getArenaMode?: () => number };
    }).$?.getArenaMode?.();
    assertEquals(
      arenaMode,
      1,
      "Prelude linker tests must run in shared-memory (multithreaded) arena mode",
    );
    const evaluated = await evaluator.reduceAsync(skiExpr);
    const decoded = await UnChurchNumber(evaluated, evaluator);
    assertEquals(decoded, 3n, "linked literal should evaluate to 3");
  } finally {
    evaluator.terminate();
  }
});

Deno.test("fails to link when module exports Nat conflicting with Prelude", async () => {
  const preludeObject = await getPreludeObject();
  const binObject = await getBinObject();
  const natObject = await getNatObject();

  const conflictingFileName = "inputs/preludeConflictingNat.trip";
  const conflictingObject = await loadTripModuleObject(
    join(__dirname, conflictingFileName),
  );

  assertThrows(
    () => {
      linkModules([
        { name: "Prelude", object: preludeObject },
        { name: "Bin", object: binObject },
        { name: "Nat", object: natObject },
        { name: "ConflictingNat", object: conflictingObject },
      ], false);
    },
    Error,
    "Ambiguous export 'Nat' found in multiple modules",
  );
});
