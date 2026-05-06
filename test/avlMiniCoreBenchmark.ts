import { strictEqual as assertEquals } from "node:assert/strict";
import { AVL_CASES } from "./avlCases.ts";
import { runAvlMiniCoreCase } from "./avlMiniCoreHarness.ts";

type AvlMiniCoreBenchmarkResult = {
  name: string;
  expected: string;
  actual: string;
  compileMs: number;
  evalMs: number;
  symbols: number;
  functionEntries: number;
  caseDispatches: number;
  constructorAllocs: number;
  primitiveOps: number;
  maxRecursionDepth: number;
};

function formatMs(value: number): string {
  return value.toFixed(3);
}

async function main(): Promise<void> {
  const emitJson = process.argv.includes("--json");
  const results: AvlMiniCoreBenchmarkResult[] = [];

  for (const testCase of AVL_CASES) {
    const result = await runAvlMiniCoreCase(testCase);
    const expected = testCase.expected;
    assertEquals(
      result.actual,
      expected,
      `MiniCore benchmark result mismatch for ${testCase.name}: expected ${expected}, got ${result.actual}`,
    );
    results.push({
      name: testCase.name,
      expected: expected.toString(),
      actual: result.actual.toString(),
      compileMs: result.compileMs,
      evalMs: result.evalMs,
      symbols: result.program.symbols.length,
      functionEntries: result.telemetry.functionEntries,
      caseDispatches: result.telemetry.caseDispatches,
      constructorAllocs: result.telemetry.constructorAllocs,
      primitiveOps: result.telemetry.primitiveOps,
      maxRecursionDepth: result.telemetry.maxRecursionDepth,
    });
  }

  if (emitJson) {
    console.log(JSON.stringify({ cases: results }, null, 2));
    return;
  }

  console.table(
    results.map((result) => ({
      case: result.name,
      compileMs: formatMs(result.compileMs),
      evalMs: formatMs(result.evalMs),
      symbols: result.symbols,
      functionEntries: result.functionEntries,
      caseDispatches: result.caseDispatches,
      constructorAllocs: result.constructorAllocs,
      primitiveOps: result.primitiveOps,
      maxRecursionDepth: result.maxRecursionDepth,
    })),
  );
}

await main();
