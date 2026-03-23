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
