import assert from "node:assert/strict";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workspaceRoot } from "../../../lib/shared/workspaceRoot.ts";
import { serializeTripBundleV1 } from "../../../lib/compiler/index.ts";
import { compileMiniCoreModules } from "../../../lib/minicore/fromTrip.ts";
import { evaluateMiniCore } from "../../../lib/minicore/evaluator.ts";
import {
  compilerTripModuleSourcePath,
  type CompilerTripModuleName,
} from "../../../lib/compiler/bootstrapModules.ts";
import { describe, it, before, after } from "../../util/test_shim.ts";
import {
  bootstrap,
  compileLlvmToExecutable,
  runExecutable,
  compileTripToLlvm,
} from "./nativeHarness.ts";

const HELLO_SOURCE = String.raw`module Main
import Prelude writeOne
export main
poly main =
  writeOne 72 [U8] (\x0 : U8 =>
    writeOne 101 [U8] (\x1 : U8 =>
      writeOne 108 [U8] (\x2 : U8 =>
        writeOne 108 [U8] (\x3 : U8 =>
          writeOne 111 [U8] (\x4 : U8 =>
            writeOne 44 [U8] (\x5 : U8 =>
              writeOne 32 [U8] (\x6 : U8 =>
                writeOne 119 [U8] (\x7 : U8 =>
                  writeOne 111 [U8] (\x8 : U8 =>
                    writeOne 114 [U8] (\x9 : U8 =>
                      writeOne 108 [U8] (\x10 : U8 =>
                        writeOne 100 [U8] (\x11 : U8 =>
                          writeOne 33 [U8] (\x12 : U8 =>
                            writeOne 10 [U8] (\x13 : U8 => x13))))))))))))))
`;

// Compare observable semantics rather than expecting the two backends to emit
// the same IR. First-order cases use the interpreter as an independent reference;
// runtime closure cases have explicitly specified output bytes.
const SEMANTIC_CASES = [
  {
    name: "arithmetic",
    definitions: "poly value = modU8 (addU8 #u8(250) #u8(20)) #u8(10)",
    expected: 4,
  },
  {
    name: "shadowing",
    definitions:
      "poly value = let x = #u8(12) in let y = x in let x = #u8(9) in subU8 y x",
    expected: 3,
  },
  {
    name: "constructors",
    definitions:
      "data Box = | Empty | Full U8\npoly value = match (Full #u8(73)) [U8] { | Empty => #u8(0) | Full x => x }",
    expected: 73,
  },
  {
    name: "short-circuit",
    definitions:
      "poly value = if [U8] true (\\u : U8 => #u8(65)) (\\u : U8 => divU8 #u8(1) #u8(0))",
    expected: 65,
  },
  {
    name: "recursion",
    definitions:
      "poly rec sum = \\n : U8 => if [U8] (eqU8 n #u8(0)) (\\u : U8 => #u8(0)) (\\u : U8 => addU8 n (sum (subU8 n #u8(1))))\npoly value = sum #u8(10)",
    expected: 55,
  },
  {
    name: "shared-global-closure",
    definitions: String.raw`poly inc = \x : U8 => addU8 x #u8(1)
poly apply = \f : U8 -> U8 => \x : U8 => f x
poly value = addU8 (apply inc #u8(31)) (apply inc #u8(32))`,
    expected: 65,
    generatedOnly: true,
  },
  {
    name: "captured-partial-application",
    definitions: String.raw`poly make = \x : U8 => let f = (\y : U8 => \z : U8 => addU8 (addU8 x y) z) in f
poly value = let f = make #u8(20) in let g = f #u8(5) in g #u8(10)`,
    expected: 35,
    generatedOnly: true,
  },
  {
    name: "global-partial-application",
    definitions: String.raw`poly add = \x : U8 => \y : U8 => addU8 x y
poly value = let f = add in let g = f #u8(30) in g #u8(35)`,
    expected: 65,
    generatedOnly: true,
  },
  {
    name: "direct-global-partial-application",
    definitions: String.raw`poly add = \x : U8 => \y : U8 => addU8 x y
poly value = let g = add #u8(30) in g #u8(35)`,
    expected: 65,
    generatedOnly: true,
  },
  {
    name: "global-returned-closure-application",
    definitions: String.raw`poly make = \x : U8 => let f = (\y : U8 => addU8 x y) in f
poly value = make #u8(30) #u8(35)`,
    expected: 65,
    generatedOnly: true,
  },
  {
    name: "global-thunk-closure-value",
    definitions: String.raw`poly thunk = let x = #u8(30) in (\y : U8 => addU8 x y)
poly value = let f = thunk in f #u8(35)`,
    expected: 65,
    generatedOnly: true,
  },
  {
    name: "independent-captures",
    definitions: String.raw`poly make = \x : U8 => let f = (\y : U8 => \z : U8 => addU8 (addU8 x y) z) in f
poly value = let f = make #u8(20) in let g = make #u8(30) in addU8 (f #u8(1) #u8(1)) (g #u8(2) #u8(2))`,
    expected: 56,
    generatedOnly: true,
  },
  {
    name: "shadowed-global-function",
    definitions: String.raw`poly inc = \x : U8 => addU8 x #u8(1)
poly value = let inc = (\x : U8 => addU8 x #u8(2)) in inc #u8(63)`,
    expected: 65,
    generatedOnly: true,
  },
];

async function checkSemanticCases(
  compilerExe: string,
  tempDir: string,
): Promise<void> {
  const prelude = {
    name: "Prelude",
    source: await readFile(join(workspaceRoot, "lib", "prelude.trip"), "utf8"),
  };
  for (const fixture of SEMANTIC_CASES) {
    const generatedOnly = "generatedOnly" in fixture && fixture.generatedOnly;
    const prefix = `module Main\nimport Prelude U8\nimport Prelude if\nimport Prelude true\nimport Prelude writeOne\nexport main\n${fixture.definitions}\n`;
    if (!generatedOnly) {
      const reference = evaluateMiniCore(
        compileMiniCoreModules(
          [prelude, { name: "Main", source: `${prefix}poly main = value\n` }],
          "Main",
        ),
      ).value;
      assert.deepEqual(
        reference,
        { kind: "lit", value: { kind: "u8", value: fixture.expected } },
        fixture.name,
      );
    }
    const source = `${prefix}poly main = writeOne value [U8] (\\u : U8 => #u8(0))\n`;
    const bundle = serializeTripBundleV1({
      entryModule: "Main",
      target: { kind: "generic" },
      emitMainWrapper: true,
      modules: [prelude, { name: "Main", source }],
    });
    const outputs = [];
    // Typed MiniCore does not represent runtime closure values. These cases
    // check independently specified output bytes; first-order cases also retain
    // the MiniCore interpreter and host LLVM comparisons.
    if (!generatedOnly) {
      outputs.push(
        await compileTripToLlvm(source, {
          moduleSources: [prelude],
          emitMainWrapper: true,
        }),
      );
    }
    outputs.push(await bootstrap.runNativeCompiler(compilerExe, bundle));
    for (const [backend, llvm] of outputs.entries()) {
      const path = join(tempDir, `${fixture.name}.${backend}.ll`);
      await writeFile(path, llvm, "utf8");
      const result = runExecutable(await compileLlvmToExecutable(path));
      assert.equal(result.status, 0, `${fixture.name}: ${result.stderr}`);
      assert.equal(
        result.stdout,
        String.fromCharCode(fixture.expected),
        `${fixture.name}, backend ${backend}`,
      );
    }
  }
}

async function checkCompilerContracts(compilerExe: string): Promise<void> {
  const invalid = runExecutable(compilerExe, "not a bundle");
  assert.equal(invalid.status, 1, invalid.stderr);
  assert.match(invalid.stdout, /^ERR:/);
  for (const kind of [
    "generic",
    "x86_64-unknown-linux-gnu",
    "arm64-apple-darwin",
    "x86_64-pc-windows-msvc",
  ] as const) {
    const llvm = await bootstrap.runNativeCompiler(
      compilerExe,
      serializeTripBundleV1({
        entryModule: "Main",
        target: { kind },
        emitMainWrapper: false,
        modules: [
          {
            name: "Main",
            source: "module Main\nexport main\npoly main = #u8(0)\n",
          },
        ],
      }),
    );
    if (kind === "generic") assert.doesNotMatch(llvm, /target triple/);
    else assert.ok(llvm.startsWith(`target triple = "${kind}"\n\n`));
    assert.doesNotMatch(llvm, /define i32 @main/);
  }
  for (const source of [
    "module Main\nexport main\npoly main = missing\n",
    "module Main\nexport main\npoly main = Main.missing\n",
    "module Main\npoly value = #u8(0)\n",
    "module Main\nexport main\npoly main = \\x : U8 => \\y : U8 => x\n",
    "module Main\nimport Missing value\nexport main\npoly main = value\n",
    "module Main\ndata Color = | Red | Green\nexport main\npoly main = match Red [U8] { | Red => #u8(0) }\n",
  ]) {
    const result = runExecutable(
      compilerExe,
      serializeTripBundleV1({
        entryModule: "Main",
        target: { kind: "generic" },
        emitMainWrapper: true,
        modules: [{ name: "Main", source }],
      }),
    );
    assert.equal(
      result.status,
      1,
      `${source}\n${result.stdout}\n${result.stderr}`,
    );
    assert.match(result.stdout, /^ERR:/);
  }
}

describe("LLVM self-host bootstrap", () => {
  let compilerExe: string;
  let cleanupBootstrap: () => Promise<void>;

  before(async () => {
    const res = await bootstrap.compileCompilerToNative();
    compilerExe = res.exePath;
    cleanupBootstrap = res.cleanup;
  });

  after(async () => {
    if (cleanupBootstrap) {
      await cleanupBootstrap();
    }
  });

  it("stage-1 agrees with reference semantics and honors bundle contracts", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "typed-ski-contracts-"));
    try {
      await checkCompilerContracts(compilerExe);
      await checkSemanticCases(compilerExe, tempDir);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("stage-0 emits a native compiler for stage-1 bundles", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "typed-ski-llvm-bootstrap-"));

    try {
      const stage1LlPath = join(tempDir, "hello.stage1.ll");
      const preludeSource = await readFile(
        join(workspaceRoot, "lib", "prelude.trip"),
        "utf8",
      );
      const bundleBytes = serializeTripBundleV1({
        entryModule: "Main",
        target: { kind: "generic" },
        emitMainWrapper: true,
        modules: [
          { name: "Main", source: HELLO_SOURCE },
          { name: "Prelude", source: preludeSource },
        ],
      });

      // Stage-1: native compiler reads bundle-v1 and emits LLVM IR.
      const stage1Ll = await bootstrap.runNativeCompiler(
        compilerExe,
        bundleBytes,
      );
      assert.ok(!stage1Ll.startsWith("ERR:"), stage1Ll);
      assert.match(stage1Ll, /define i64 @trip_fn_Main_main\(i64 %/);
      await writeFile(stage1LlPath, stage1Ll, "utf8");

      // Compile Stage-1 LLVM to a native executable
      const stage1Exe = await compileLlvmToExecutable(stage1LlPath);

      // Run the Stage-1 executable
      const result = runExecutable(stage1Exe);
      assert.equal(result.status, 0);
      assert.equal(result.stdout, "Hello, world!\n");

      const multiModuleLlPath = join(tempDir, "multi-module.stage1.ll");
      const multiModuleBundle = serializeTripBundleV1({
        entryModule: "App",
        target: { kind: "generic" },
        emitMainWrapper: true,
        modules: [
          { name: "Prelude", source: preludeSource },
          {
            name: "Lib",
            source: `module Lib
export seven
poly seven = #u8(7)
`,
          },
          {
            name: "App",
            source: `module App
import Lib seven
import Prelude writeOne
export main
poly main = writeOne seven [U8] (\\u : U8 => #u8(0))
`,
          },
        ],
      });

      const multiModuleLl = await bootstrap.runNativeCompiler(
        compilerExe,
        multiModuleBundle,
      );
      assert.ok(!multiModuleLl.startsWith("ERR:"), multiModuleLl);
      assert.match(multiModuleLl, /define i64 @trip_fn_Lib_seven\(i64 %/);
      assert.match(multiModuleLl, /define i64 @trip_fn_App_main\(i64 %/);
      assert.match(multiModuleLl, /call i64 @trip_fn_Lib_seven\(i64 /);
      assert.match(multiModuleLl, /call i64 @trip_fn_App_main\(i64 /);
      await writeFile(multiModuleLlPath, multiModuleLl, "utf8");

      const multiModuleExe = await compileLlvmToExecutable(multiModuleLlPath);
      const multiModuleResult = runExecutable(multiModuleExe);
      assert.equal(multiModuleResult.status, 0);
      assert.equal(multiModuleResult.stdout, "\u0007");
    } finally {
      await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("stage-1 native compiler compiling the full compiler bundle", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "typed-ski-llvm-selfcomp-"));

    try {
      const moduleNames: readonly CompilerTripModuleName[] = [
        "Prelude",
        "Nat",
        "Bin",
        "BundleSummary",
        "Avl",
        "Lexer",
        "Parser",
        "Core",
        "DataEnv",
        "Unparse",
        "Bridge",
        "Llvm",
        "BundleParseSummary",
        "BundleInventory",
        "ModuleEnv",
        "CoreToMini",
        "MiniCore",
        "MiniVerify",
        "Anf",
        "AnfLlvm",
        "Compiler",
      ];

      const modules = await Promise.all(
        moduleNames.map(async (name) => ({
          name,
          source: await readFile(compilerTripModuleSourcePath(name), "utf8"),
        })),
      );

      const compilerBundleBytes = serializeTripBundleV1({
        entryModule: "Compiler",
        target: { kind: "generic" },
        emitMainWrapper: true,
        modules,
      });

      // Stage-1: native compiler reads compilerBundleBytes and emits LLVM IR.
      console.log("Running stage-1 compiler on the full compiler bundle...");
      const stage2Ll = await bootstrap.runNativeCompiler(
        compilerExe,
        compilerBundleBytes,
      );
      assert.ok(stage2Ll);
      assert.ok(!stage2Ll.startsWith("ERR:"), stage2Ll);
    } finally {
      await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("reaches a byte-identical LLVM IR fixpoint through Stage 4", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "typed-ski-llvm-fixpoint-"));

    try {
      const moduleNames: readonly CompilerTripModuleName[] = [
        "Prelude",
        "Nat",
        "Bin",
        "BundleSummary",
        "Avl",
        "Lexer",
        "Parser",
        "Core",
        "DataEnv",
        "Unparse",
        "Bridge",
        "Llvm",
        "BundleParseSummary",
        "BundleInventory",
        "ModuleEnv",
        "CoreToMini",
        "MiniCore",
        "MiniVerify",
        "Anf",
        "AnfLlvm",
        "Compiler",
      ];

      const modules = await Promise.all(
        moduleNames.map(async (name) => ({
          name,
          source: await readFile(compilerTripModuleSourcePath(name), "utf8"),
        })),
      );

      const compilerBundleBytes = serializeTripBundleV1({
        entryModule: "Compiler",
        target: { kind: "generic" },
        emitMainWrapper: true,
        modules,
      });

      // Stage-2 LLVM IR = compile using Stage-1 compiler executable
      const stage2Ll = await bootstrap.runNativeCompiler(
        compilerExe,
        compilerBundleBytes,
      );

      const stage2LlPath = join(tempDir, "stage2.ll");
      await writeFile(stage2LlPath, stage2Ll, "utf8");

      // Stage-2 compiler executable = compile Stage-2 LLVM IR to native
      const stage2Exe = await compileLlvmToExecutable(stage2LlPath);

      // Stage-3 LLVM IR = compile using Stage-2 compiler executable
      const stage3Ll = await bootstrap.runNativeCompiler(
        stage2Exe,
        compilerBundleBytes,
      );

      const stage3LlPath = join(tempDir, "stage3.ll");
      await writeFile(stage3LlPath, stage3Ll, "utf8");

      // Stage-3 compiler executable = compile Stage-3 LLVM IR to native
      const stage3Exe = await compileLlvmToExecutable(stage3LlPath);

      // Stage-4 LLVM IR = compile using Stage-3 compiler executable
      const stage4Ll = await bootstrap.runNativeCompiler(
        stage3Exe,
        compilerBundleBytes,
      );

      // Assert that Stage 2 LLVM IR is byte-identical to Stage 3 LLVM IR!
      assert.equal(stage2Ll, stage3Ll);

      // Assert that Stage 3 LLVM IR is byte-identical to Stage 4 LLVM IR (no 2-cycle oscillation)!
      assert.equal(stage3Ll, stage4Ll);

      await checkCompilerContracts(stage3Exe);
      await checkSemanticCases(stage3Exe, tempDir);

      // --- Correctness Anchors compiled and executed via Stage 3 compiler ---
      const preludeSource = await readFile(
        join(workspaceRoot, "lib", "prelude.trip"),
        "utf8",
      );

      const helloBundleBytes = serializeTripBundleV1({
        entryModule: "Main",
        target: { kind: "generic" },
        emitMainWrapper: true,
        modules: [
          { name: "Main", source: HELLO_SOURCE },
          { name: "Prelude", source: preludeSource },
        ],
      });

      console.log("Compiling hello correctness anchor via stage-3 compiler...");
      const helloStage3Ll = await bootstrap.runNativeCompiler(
        stage3Exe,
        helloBundleBytes,
      );
      assert.ok(!helloStage3Ll.startsWith("ERR:"), helloStage3Ll);
      const helloStage3LlPath = join(tempDir, "hello.stage3.ll");
      await writeFile(helloStage3LlPath, helloStage3Ll, "utf8");

      const helloStage3Exe = await compileLlvmToExecutable(helloStage3LlPath);
      const helloResult = runExecutable(helloStage3Exe);
      assert.equal(helloResult.status, 0);
      assert.equal(helloResult.stdout, "Hello, world!\n");

      // Multi-module correctness check using Stage 3 compiler
      const multiModuleBundle = serializeTripBundleV1({
        entryModule: "App",
        target: { kind: "generic" },
        emitMainWrapper: true,
        modules: [
          { name: "Prelude", source: preludeSource },
          {
            name: "Lib",
            source: `module Lib
export seven
poly seven = #u8(7)
`,
          },
          {
            name: "App",
            source: `module App
import Lib seven
import Prelude writeOne
export main
poly main = writeOne seven [U8] (\\u : U8 => #u8(0))
`,
          },
        ],
      });

      console.log(
        "Compiling multi-module correctness anchor via stage-3 compiler...",
      );
      const multiModuleStage3Ll = await bootstrap.runNativeCompiler(
        stage3Exe,
        multiModuleBundle,
      );
      assert.ok(!multiModuleStage3Ll.startsWith("ERR:"), multiModuleStage3Ll);
      const multiModuleStage3LlPath = join(tempDir, "multi-module.stage3.ll");
      await writeFile(multiModuleStage3LlPath, multiModuleStage3Ll, "utf8");

      const multiModuleStage3Exe = await compileLlvmToExecutable(
        multiModuleStage3LlPath,
      );
      const multiModuleResult = runExecutable(multiModuleStage3Exe);
      assert.equal(multiModuleResult.status, 0);
      assert.equal(multiModuleResult.stdout, "\u0007");
    } finally {
      await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }, 240000);
});
