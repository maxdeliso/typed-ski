/**
 * Stage-0 native verification of the Trip-side ANF -> LLVM emitter.
 *
 * `anfLlvmEmit.test.ts` already checks AnfLlvm under the host MiniCore
 * evaluator. This test compiles a small Trip harness to a native executable,
 * then runs `AnfLlvm.compileSourceToLlvmText` inside that executable.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "../../util/test_shim.ts";
import type { CompilerTripModuleName } from "../../../lib/compiler/bootstrapModules.ts";
import {
  compileLlvmToExecutable,
  compileTripToLlvm,
  loadCommonModules,
  runExecutable,
} from "./nativeHarness.ts";

const ANF_LLVM_MODULE_NAMES: readonly CompilerTripModuleName[] = [
  "Prelude",
  "Nat",
  "Bin",
  "Avl",
  "Lexer",
  "Parser",
  "Core",
  "DataEnv",
  "CoreToLower",
  "Unparse",
  "Lowering",
  "Bridge",
  "CoreToMini",
  "MiniCore",
  "Anf",
  "AnfLlvm",
];

const DEMO_SOURCE = String.raw`module Demo
import Prelude writeOne
export main
poly main = \a : U8 => writeOne (addU8 a #u8(1)) [U8] (\u : U8 => u)
`;

const EXPECTED_LLVM = `declare void @trip_write_one(i8)
declare i8 @trip_read_one()

define i8 @main(i8 %a) {
entry:
  %__ll0 = add i8 %a, 1
  call void @trip_write_one(i8 %__ll0)
  ret i8 %__ll0
}

`;

function buildVerifySource(source: string): string {
  return String.raw`module Verify
import Prelude List
import Prelude U8
import Prelude matchList
import Prelude writeOne
import AnfLlvm compileSourceToLlvmText

export main

poly rec writeAll = \bytes : List U8 =>
  matchList [U8] [U8] bytes
    #u8(0)
    (\h : U8 => \t : List U8 => writeOne h [U8] (\u : U8 => writeAll t))

poly main = writeAll (compileSourceToLlvmText ${JSON.stringify(source)})
`;
}

describe("AnfLlvm native self-host", () => {
  it("stage-0 emits a native executable whose AnfLlvm output matches the host expectation", async () => {
    const moduleSources = await loadCommonModules([...ANF_LLVM_MODULE_NAMES]);
    const verifySource = buildVerifySource(DEMO_SOURCE);
    const llvm = await compileTripToLlvm(verifySource, {
      entryModule: "Verify",
      moduleSources,
      emitMainWrapper: true,
    });

    const tempDir = await mkdtemp(join(tmpdir(), "typed-ski-anf-llvm-"));
    try {
      const llPath = join(tempDir, "anf-llvm-verify.ll");
      await writeFile(llPath, llvm, "utf8");
      const exePath = await compileLlvmToExecutable(llPath);
      const result = runExecutable(exePath);

      assert.equal(result.status, 0);
      assert.equal(result.stderr, "");
      assert.equal(result.stdout, EXPECTED_LLVM);
    } finally {
      await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  });
});
