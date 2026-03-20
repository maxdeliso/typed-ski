import { assert } from "chai";
import type { TripCObject } from "../../lib/compiler/objectFile.ts";
import { linkModules } from "../../lib/linker/moduleLinker.ts";
import { getPreludeObject } from "../../lib/prelude.ts";
import { parseSKI } from "../../lib/parser/ski.ts";
import { loadTripModuleObject } from "../../lib/tripSourceLoader.ts";
import { compileToObjectFile } from "../../lib/compiler/singleFileCompiler.ts";
import { ParallelArenaEvaluatorWasm } from "../../lib/index.ts";

const UNPARSE_SOURCE_FILE = new URL(
  "../../lib/compiler/unparse.trip",
  import.meta.url,
);

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

    // Stage 1 validates the entire unparsed output.
    const testCases: Array<{ name: string; trip: string; expected: string }> = [
      {
        name: "single terminal S",
        trip: "unparseCombinator (C_Term T_S)",
        expected: "S",
      },
      {
        name: "simple application (SK)",
        trip: "unparseCombinator (C_App (C_Term T_S) (C_Term T_K))",
        expected: "(S K)",
      },
      {
        name: "nested application ((SK)I)",
        trip:
          "unparseCombinator (C_App (C_App (C_Term T_S) (C_Term T_K)) (C_Term T_I))",
        expected: "((S K) I)",
      },
      {
        name: "native terminal WriteOne",
        trip: "unparseCombinator (C_Term T_WriteOne)",
        expected: ".",
      },
      {
        name: "native application (S.)",
        trip: "unparseCombinator (C_App (C_Term T_S) (C_Term T_WriteOne))",
        expected: "(S .)",
      },
      {
        name: "byte literal #u8(65)",
        trip: "unparseCombinator (C_Term (T_Byte #u8(65)))",
        expected: "#u8(65)",
      },
      {
        name: "byte literal #u8(0)",
        trip: "unparseCombinator (C_Term (T_Byte #u8(0)))",
        expected: "#u8(0)",
      },
      {
        name: "byte literal #u8(255)",
        trip: "unparseCombinator (C_Term (T_Byte #u8(255)))",
        expected: "#u8(255)",
      },
      {
        name: "intrinsic LtU8",
        trip: "unparseCombinator (C_Term T_LtU8)",
        expected: "L",
      },
      {
        name: "intrinsic DivU8",
        trip: "unparseCombinator (C_Term T_DivU8)",
        expected: "D",
      },
      {
        name: "intrinsic ModU8",
        trip: "unparseCombinator (C_Term T_ModU8)",
        expected: "M",
      },
      {
        name: "intrinsic AddU8",
        trip: "unparseCombinator (C_Term T_AddU8)",
        expected: "A",
      },
    ];

    const evaluator = await ParallelArenaEvaluatorWasm.create(1);

    try {
      for (const tc of testCases) {
        const testSource = `module Test
import Prelude List
import Prelude U8
import Prelude matchList
import Prelude writeOne
import Unparse Terminal
import Unparse T_S
import Unparse T_K
import Unparse T_I
import Unparse T_WriteOne
import Unparse T_Byte
import Unparse Comb
import Unparse C_Term
import Unparse C_App
import Unparse unparseCombinator

poly rec writeList = #R => \\l : List => \\k : R =>
  matchList [U8] [R] l
    k
    (\\h : U8 => \\t : List => writeOne h [R] (\\u : U8 => writeList [R] t k))

export main
poly main = writeList [U8] (${tc.trip}) #u8(0)
`;
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
