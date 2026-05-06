import assert from "node:assert/strict";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "../../util/test_shim.ts";
import {
  bootstrap,
  compileLlvmToExecutable,
  runExecutable,
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

describe("LLVM self-host bootstrap", () => {
  it(
    "stage-0 emits a native compiler that emits and runs hello-world LLVM",
    { timeout: 300_000 },
    async () => {
      const { exePath: compilerExe, cleanup: cleanupBootstrap } =
        await bootstrap.compileCompilerToNative();
      const tempDir = await mkdtemp(
        join(tmpdir(), "typed-ski-llvm-bootstrap-"),
      );

      try {
        const stage1LlPath = join(tempDir, "hello.stage1.ll");

        // Stage-1: Native compiler (Stage-1) reads HELLO_SOURCE and emits LLVM IR
        const stage1Ll = await bootstrap.runNativeCompiler(
          compilerExe,
          HELLO_SOURCE,
        );
        assert.ok(!stage1Ll.startsWith("ERR:"), stage1Ll);
        assert.match(stage1Ll, /define i8 @trip_fn_Main_main\(\)/);
        await writeFile(stage1LlPath, stage1Ll, "utf8");

        // Compile Stage-1 LLVM to a native executable
        const stage1Exe = await compileLlvmToExecutable(stage1LlPath);

        // Run the Stage-1 executable
        const result = runExecutable(stage1Exe);
        assert.equal(result.status, 0);
        assert.equal(result.stdout, "Hello, world!\n");
      } finally {
        await Promise.all([
          cleanupBootstrap(),
          rm(tempDir, { recursive: true, force: true }).catch(() => {}),
        ]);
      }
    },
  );
});
