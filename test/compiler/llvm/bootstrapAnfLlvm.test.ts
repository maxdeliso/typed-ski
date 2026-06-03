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
  type RunResult,
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

// Exercises the nullary-constructor path (AE_Con with no fields -> its i8
// tag, added in #186). `Green` is the second constructor of `Color`, so its
// declaration-order tag is 1. No `declare` prelude: the program uses no IO.
const NULLARY_CON_SOURCE = String.raw`module Demo
data Color = | Red | Green | Blue
export main
poly main = Green
`;

const NULLARY_CON_EXPECTED = `define i8 @main() {
entry:
  ret i8 1
}

`;

// Exercises the AE_Case path: a match on a nullary enum lowers to a `switch`
// on the scrutinee's i8 tag, with each arm storing to an alloca slot that a
// shared `end` block loads (alloca/store/load rather than phi).
const MATCH_SOURCE = String.raw`module Demo
data Color = | Red | Green | Blue
export main
poly main = \c : Color => match c [U8] { | Red => #u8(10) | Green => #u8(20) | Blue => #u8(30) }
`;

const MATCH_EXPECTED = `define i8 @main(i8 %c) {
entry:
  %__case0.slot = alloca i8
  switch i8 %c, label %__case0.default [
    i8 0, label %__case0.arm0
    i8 1, label %__case0.arm1
    i8 2, label %__case0.arm2
  ]
__case0.arm0:
  store i8 10, ptr %__case0.slot
  br label %__case0.end
__case0.arm1:
  store i8 20, ptr %__case0.slot
  br label %__case0.end
__case0.arm2:
  store i8 30, ptr %__case0.slot
  br label %__case0.end
__case0.default:
  unreachable
__case0.end:
  %__case0.result = load i8, ptr %__case0.slot
  ret i8 %__case0.result
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

/**
 * Compiles the `Verify` harness wrapped around `demoSource` to a native
 * executable, runs it, and returns the result. The executable's stdout is the
 * LLVM text the native AnfLlvm emitter produced for `demoSource`.
 */
async function emitNatively(demoSource: string): Promise<RunResult> {
  const moduleSources = await loadCommonModules([...ANF_LLVM_MODULE_NAMES]);
  const verifySource = buildVerifySource(demoSource);
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
    return runExecutable(exePath);
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

describe("AnfLlvm native self-host", () => {
  it("stage-0 emits a native executable whose AnfLlvm output matches the host expectation", async () => {
    const result = await emitNatively(DEMO_SOURCE);

    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    assert.equal(result.stdout, EXPECTED_LLVM);
  });

  it("stage-0 emits nullary constructors as their i8 tag through the native path", async () => {
    const result = await emitNatively(NULLARY_CON_SOURCE);

    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    assert.equal(result.stdout, NULLARY_CON_EXPECTED);
  });

  it("stage-0 lowers a match on a nullary enum to a switch through the native path", async () => {
    const result = await emitNatively(MATCH_SOURCE);

    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    assert.equal(result.stdout, MATCH_EXPECTED);
  });
});
