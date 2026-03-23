import { assert } from "chai";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { TripCObject } from "../../lib/compiler/objectFile.ts";
import { linkModules } from "../../lib/linker/moduleLinker.ts";
import { getPreludeObject } from "../../lib/prelude.ts";
import { parseSKI } from "../../lib/parser/ski.ts";
import { loadTripModuleObject } from "../../lib/tripSourceLoader.ts";
import { compileToObjectFile } from "../../lib/compiler/singleFileCompiler.ts";
import { ParallelArenaEvaluatorWasm } from "../../lib/index.ts";
import { loadInput } from "../util/fileLoader.ts";
import {
  thanatosAvailable,
  ThanatosSession,
  toDagWire,
} from "../thanatosHarness.test.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

const UNPARSE_SOURCE_FILE = new URL(
  "../../lib/compiler/unparse.trip",
  import.meta.url,
);

function loadUnparseStage1Input(fileName: string): string {
  return loadInput(`unparseStage1/${fileName}`, __dirname);
}

let unparseObject: TripCObject | null = null;
let preludeObject: TripCObject | null = null;

async function getUnparseObject() {
  if (!unparseObject) {
    unparseObject = await loadTripModuleObject(UNPARSE_SOURCE_FILE);
  }
  return unparseObject;
}

async function getPreludeObjectCached() {
  if (!preludeObject) {
    preludeObject = await getPreludeObject();
  }
  return preludeObject;
}

function makeUnparseBenchmarkModule(
  moduleName: string,
  leafCount: number,
  useBaseline: boolean,
): string {
  const leaves = Array.from(
    { length: leafCount },
    (_, i) => `(C_Term (T_Byte #u8(${32 + (i % 90)})))`,
  );
  const benchComb = leaves.slice(1).reduce(
    (acc, leaf) => `(C_App ${acc} ${leaf})`,
    leaves[0]!,
  );
  const mainExpr = useBaseline
    ? "baselineUnparseCombinator benchComb"
    : "unparseCombinator benchComb";

  return `module ${moduleName}
import Prelude List
import Prelude U8
import Prelude append
import Unparse Comb
import Unparse C_Term
import Unparse C_App
import Unparse T_Byte
import Unparse terminalBytes
import Unparse unparseCombinator

export main

poly rec baselineUnparseCombinator = \\c : Comb =>
  match c [List U8] {
    | C_Term t => terminalBytes t
    | C_App l r =>
        append [U8] "(" (append [U8] (baselineUnparseCombinator l) (append [U8] " " (append [U8] (baselineUnparseCombinator r) ")")))
  }

poly benchComb = ${benchComb}

poly main = ${mainExpr}
`;
}

async function measureThanatosReduction(skiExpression: string): Promise<{
  elapsedMs: number;
  totalSteps: number;
  resultDag: string;
}> {
  const session = new ThanatosSession();

  try {
    session.start(1);
    await session.ping();
    await session.reset();

    const startTime = performance.now();
    const resultDag = await session.reduceDag(
      toDagWire(parseSKI(skiExpression)),
    );
    const elapsedMs = performance.now() - startTime;
    const statsLine = await session.stats();
    const stepsMatch = statsLine.match(/total_steps=(\d+)/);

    return {
      elapsedMs,
      totalSteps: stepsMatch ? parseInt(stepsMatch[1]!, 10) : 0,
      resultDag,
    };
  } finally {
    await session.close();
  }
}

Deno.test({
  name: "Unparse - Stage 1 Corpus",
  fn: async () => {
    const unparseObj = await getUnparseObject();
    const preludeObj = await getPreludeObjectCached();
    const stage1Harness = loadUnparseStage1Input("harness.trip");

    // Stage 1 validates the entire unparsed output.
    const testCases: Array<{ name: string; file: string; expected: string }> = [
      {
        name: "single terminal S",
        file: "singleTerminalS.trip",
        expected: "S",
      },
      {
        name: "simple application (SK)",
        file: "simpleApplicationSK.trip",
        expected: "(S K)",
      },
      {
        name: "nested application ((SK)I)",
        file: "nestedApplicationSKI.trip",
        expected: "((S K) I)",
      },
      {
        name: "native terminal WriteOne",
        file: "nativeTerminalWriteOne.trip",
        expected: ".",
      },
      {
        name: "native application (S.)",
        file: "nativeApplicationSWriteOne.trip",
        expected: "(S .)",
      },
      {
        name: "byte literal #u8(9)",
        file: "byteLiteral9.trip",
        expected: "#u8(9)",
      },
      {
        name: "byte literal #u8(10)",
        file: "byteLiteral10.trip",
        expected: "#u8(10)",
      },
      {
        name: "byte literal #u8(65)",
        file: "byteLiteral65.trip",
        expected: "#u8(65)",
      },
      {
        name: "byte literal #u8(99)",
        file: "byteLiteral99.trip",
        expected: "#u8(99)",
      },
      {
        name: "byte literal #u8(100)",
        file: "byteLiteral100.trip",
        expected: "#u8(100)",
      },
      {
        name: "byte literal #u8(0)",
        file: "byteLiteral0.trip",
        expected: "#u8(0)",
      },
      {
        name: "byte literal #u8(255)",
        file: "byteLiteral255.trip",
        expected: "#u8(255)",
      },
      {
        name: "intrinsic LtU8",
        file: "intrinsicLtU8.trip",
        expected: "L",
      },
      {
        name: "intrinsic DivU8",
        file: "intrinsicDivU8.trip",
        expected: "D",
      },
      {
        name: "intrinsic ModU8",
        file: "intrinsicModU8.trip",
        expected: "M",
      },
      {
        name: "intrinsic AddU8",
        file: "intrinsicAddU8.trip",
        expected: "A",
      },
    ];

    const evaluator = await ParallelArenaEvaluatorWasm.create(1);

    try {
      for (const tc of testCases) {
        const testSource = stage1Harness.replace(
          "__TRIP_EXPR__",
          loadUnparseStage1Input(tc.file),
        );
        const testObj = compileToObjectFile(testSource);
        const skiExpression = linkModules([
          { name: "Prelude", object: preludeObj },
          { name: "Unparse", object: unparseObj },
          { name: "Test", object: testObj },
        ]);

        const expr = parseSKI(skiExpression);
        await evaluator.reduceAsync(expr);
        const stdout = await evaluator.readStdout(1024);
        const result = new TextDecoder().decode(stdout);

        assert.equal(result, tc.expected, `Test ${tc.name} failed`);

        evaluator.reset();
      }
    } finally {
      evaluator.terminate();
    }
  },
});

Deno.test({
  name: "Unparse - accumulator benchmark beats nested append baseline",
  ignore: !thanatosAvailable() || Deno.env.get("RUN_UNPARSE_BENCH") !== "1",
  fn: async () => {
    const unparseObj = await getUnparseObject();
    const preludeObj = await getPreludeObjectCached();
    const currentObj = compileToObjectFile(
      makeUnparseBenchmarkModule("BenchCurrent", 12, false),
      { importedModules: [preludeObj, unparseObj] },
    );
    const baselineObj = compileToObjectFile(
      makeUnparseBenchmarkModule("BenchBaseline", 12, true),
      { importedModules: [preludeObj, unparseObj] },
    );

    const currentSki = linkModules([
      { name: "Prelude", object: preludeObj },
      { name: "Unparse", object: unparseObj },
      { name: "BenchCurrent", object: currentObj },
    ]);
    const baselineSki = linkModules([
      { name: "Prelude", object: preludeObj },
      { name: "Unparse", object: unparseObj },
      { name: "BenchBaseline", object: baselineObj },
    ]);

    const current = await measureThanatosReduction(currentSki);
    const baseline = await measureThanatosReduction(baselineSki);

    console.log(
      `[phase6 local benchmark] current_ms=${
        current.elapsedMs.toFixed(2)
      } baseline_ms=${
        baseline.elapsedMs.toFixed(2)
      } current_steps=${current.totalSteps} baseline_steps=${baseline.totalSteps}`,
    );

    assert.equal(
      current.resultDag,
      baseline.resultDag,
      "current and baseline unparse results diverged",
    );
    assert.isBelow(
      current.elapsedMs,
      baseline.elapsedMs,
      "expected accumulator unparse to beat baseline wall time",
    );
    assert.isBelow(
      current.totalSteps,
      baseline.totalSteps,
      "expected accumulator unparse to beat baseline step count",
    );
  },
});
