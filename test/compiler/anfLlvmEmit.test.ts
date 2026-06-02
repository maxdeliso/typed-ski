/**
 * Stage-0 verification of the .trip ANF -> LLVM emitter (anfLlvm.trip).
 *
 * Runs `AnfLlvm.compileSourceToLlvmText` under the TypeScript MiniCore
 * evaluator on a small straight-line `U8` corpus (params, let-bindings,
 * and direct known-symbol calls) and asserts the emitted LLVM text. This
 * is the minimal slice of the ANF->LLVM tail: no constructors, cases,
 * inner lambdas, or runtime primitives yet.
 */

import { describe, it } from "../util/test_shim.ts";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  compilerTripModuleSourcePath,
  type CompilerTripModuleName,
} from "../../lib/compiler/bootstrapModules.ts";
import { serializeTripBundleV1 } from "../../lib/compiler/index.ts";
import { compileMiniCoreModules } from "../../lib/minicore/fromTrip.ts";
import { evaluateMiniCore } from "../../lib/minicore/evaluator.ts";
import type { Value } from "../../lib/minicore/ast.ts";
import {
  compileLlvmToExecutable,
  compileTripToLlvm,
  loadCommonModules,
  runExecutable,
} from "./llvm/nativeHarness.ts";

const ANF_LLVM_MODULE_NAMES = [
  "Prelude",
  "Nat",
  "Bin",
  "BundleSummary",
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
] as const satisfies readonly CompilerTripModuleName[];

const COMPILER_ANF_MODULE_NAMES = [
  ...ANF_LLVM_MODULE_NAMES,
  "Llvm",
  "Compiler",
] as const satisfies readonly CompilerTripModuleName[];

/** Decodes a Scott/ADT-encoded `List U8` MiniCore value to a byte array. */
function valueToBytes(value: Value): number[] {
  const bytes: number[] = [];
  let cur: Value = value;
  while (cur.kind === "con" && cur.fields.length === 2) {
    const head = cur.fields[0];
    const tail = cur.fields[1];
    if (head === undefined || tail === undefined || head.kind !== "lit") {
      throw new Error(`expected u8 list head, got ${JSON.stringify(head)}`);
    }
    const literal = head.value;
    if (literal.kind !== "u8") {
      throw new Error(`expected u8 list head, got ${JSON.stringify(head)}`);
    }
    bytes.push(literal.value);
    cur = tail;
  }
  if (cur.kind !== "con" || cur.fields.length !== 0) {
    throw new Error(`expected nil terminator, got ${JSON.stringify(cur)}`);
  }
  return bytes;
}

const DEMO_SOURCE = `module Demo
export konst
export main
poly konst = \\x : U8 => \\y : U8 => x
poly main = \\z : U8 => konst (konst z z) z
`;

const EXPECTED_LLVM = `declare void @trip_write_one(i8)
declare i8 @trip_read_one()
declare ptr @trip_alloc_obj(i64, i64)
declare void @trip_obj_set_field(ptr, i64, i64)
declare i64 @trip_obj_tag(ptr)
declare i64 @trip_obj_field(ptr, i64)

define i64 @konst(i64 %x, i64 %y) {
entry:
  ret i64 %x
}

define i64 @main(i64 %z) {
entry:
  %__ll0 = call i64 @konst(i64 %z, i64 %z)
  %__ll1 = call i64 @konst(i64 %__ll0, i64 %z)
  ret i64 %__ll1
}

`;

function bundleText(
  source: string,
  options: {
    emitMainWrapper?: boolean;
    target?:
      | "generic"
      | "x86_64-unknown-linux-gnu"
      | "arm64-apple-darwin"
      | "x86_64-pc-windows-msvc";
    modules?: Array<{ name: string; source: string }>;
  } = {},
): string {
  return Buffer.from(
    serializeTripBundleV1({
      entryModule: "Demo",
      target: { kind: options.target ?? "generic" },
      emitMainWrapper: options.emitMainWrapper,
      modules: options.modules ?? [{ name: "Demo", source }],
    }),
  ).toString("utf8");
}

async function evaluateListMain(
  moduleNames: readonly CompilerTripModuleName[],
  verifySource: string,
): Promise<string> {
  const modules: Array<{ name: string; source: string }> = await Promise.all(
    moduleNames.map(async (name) => ({
      name,
      source: await readFile(compilerTripModuleSourcePath(name), "utf8"),
    })),
  );
  modules.push({ name: "Verify", source: verifySource });

  const program = compileMiniCoreModules(modules, "Verify");
  const result = evaluateMiniCore(program);
  return Buffer.from(valueToBytes(result.value)).toString("utf8");
}

function compilerBundleVerifySource(input: string): string {
  return `module Verify
import Prelude List
import Prelude U8
import Prelude Result
import Prelude Err
import Prelude Ok
import Prelude append
import Compiler compileBundleToAnfLlvm

export main

poly main =
  match (compileBundleToAnfLlvm ${JSON.stringify(input)}) [List U8] {
    | Err e => append [U8] "ERR:" e
    | Ok llvm => llvm
  }
`;
}

function compilerBundleNativeVerifySource(): string {
  return `module Verify
import Prelude List
import Prelude U8
import Prelude Result
import Prelude Err
import Prelude Ok
import Prelude append
import Prelude matchList
import Prelude writeOne
import Compiler compileBundleToAnfLlvm

export main

poly rec writeAll =
  \\bytes : List U8 =>
    matchList [U8] [U8] bytes #u8(0) (\\h : U8 => \\t : List U8 => writeOne h [U8] (\\u : U8 => writeAll t))

poly main =
  \\source : List U8 =>
    match (compileBundleToAnfLlvm source) [U8] {
      | Err e => writeAll (append [U8] "ERR:" e)
      | Ok llvm => writeAll llvm
    }
`;
}

describe("ANF -> LLVM emitter (.trip)", () => {
  it("emits LLVM for the straight-line U8 subset (params, lets, calls)", async () => {
    const actual = await evaluateListMain(
      ANF_LLVM_MODULE_NAMES,
      `module Verify
import Prelude List
import Prelude U8
import AnfLlvm compileSourceToLlvmText

export main

poly main = compileSourceToLlvmText ${JSON.stringify(DEMO_SOURCE)}
`,
    );

    assert.equal(actual, EXPECTED_LLVM);
  });

  it("routes a single-module bundle through Compiler.compileBundleToAnfLlvm", async () => {
    const actual = await evaluateListMain(
      COMPILER_ANF_MODULE_NAMES,
      compilerBundleVerifySource(bundleText(DEMO_SOURCE)),
    );

    assert.equal(actual, EXPECTED_LLVM);
  });

  it("rejects bundle shapes outside the additive ANF LLVM seam", async () => {
    const helperSource = `module Helper
export id
poly id = \\x : U8 => x
`;
    const unsupportedLiteralSource = `module Demo
export main
poly main = #u8(7)
`;
    const cases: Array<[string, string, RegExp]> = [
      [
        "wrapper enabled",
        bundleText(DEMO_SOURCE, { emitMainWrapper: true }),
        /ERR:Unsupported ANF LLVM bundle: wrapper must be none/,
      ],
      [
        "non-generic target",
        bundleText(DEMO_SOURCE, { target: "x86_64-unknown-linux-gnu" }),
        /ERR:Unsupported ANF LLVM bundle: target must be generic/,
      ],
      [
        "multiple modules",
        bundleText(DEMO_SOURCE, {
          modules: [
            { name: "Demo", source: DEMO_SOURCE },
            { name: "Helper", source: helperSource },
          ],
        }),
        /ERR:Unsupported ANF LLVM bundle: expected one module/,
      ],
      [
        "unsupported source shape",
        bundleText(unsupportedLiteralSource),
        /ERR:Unsupported expression: native/,
      ],
    ];

    for (const [name, input, expected] of cases) {
      const actual = await evaluateListMain(
        COMPILER_ANF_MODULE_NAMES,
        compilerBundleVerifySource(input),
      );
      assert.match(actual, expected, name);
    }
  });

  it("emits LLVM and reports bundle errors from a native stage-0 verifier", async () => {
    const moduleSources = await loadCommonModules([
      ...COMPILER_ANF_MODULE_NAMES,
    ]);
    const llvm = await compileTripToLlvm(compilerBundleNativeVerifySource(), {
      entryModule: "Verify",
      moduleSources,
      emitMainWrapper: true,
    });

    const tempDir = await mkdtemp(join(tmpdir(), "typed-ski-anf-llvm-"));
    try {
      const llPath = join(tempDir, "verify.ll");
      await writeFile(llPath, llvm, "utf8");
      const exePath = await compileLlvmToExecutable(llPath);
      const result = runExecutable(exePath, bundleText(DEMO_SOURCE));

      assert.equal(result.status, 0);
      assert.equal(result.stderr, "");
      assert.equal(result.stdout, EXPECTED_LLVM);

      const rejected = runExecutable(
        exePath,
        bundleText(DEMO_SOURCE, { emitMainWrapper: true }),
      );
      assert.equal(rejected.status, 0);
      assert.equal(rejected.stderr, "");
      assert.equal(
        rejected.stdout,
        "ERR:Unsupported ANF LLVM bundle: wrapper must be none",
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  });
});
