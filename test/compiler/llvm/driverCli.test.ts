import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "../../util/test_shim.ts";
import { serializeTripBundleV1 } from "../../../lib/compiler/index.ts";
import { projectRoot, tripcScriptPath } from "../../util/tripcHarness.ts";

function runNodeScript(script: string, args: string[]) {
  return spawnSync(
    process.execPath,
    [
      "--disable-warning=ExperimentalWarning",
      script,
      ...args,
    ],
    {
      cwd: projectRoot,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    },
  );
}

describe("tripc LLVM driver", () => {
  it("emits LLVM to a file", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "typed-ski-tripc-llvm-"));
    try {
      const tripcOut = join(tempDir, "tripc.ll");

      const tripc = runNodeScript(tripcScriptPath, [
        "--emit",
        "llvm",
        "test/compiler/llvm/helloWorld.trip",
        tripcOut,
        "--entry-module",
        "Main",
        "--module-source",
        "Prelude=lib/prelude.trip",
        "--target",
        "x86_64-unknown-linux-gnu",
        "--emit-main-wrapper",
      ]);
      assert.equal(tripc.status, 0, tripc.stderr);

      const outContent = readFileSync(tripcOut, "utf8");
      assert.match(outContent, /target triple = "x86_64-unknown-linux-gnu"/);
      assert.match(outContent, /define i8 @trip_fn_Main_main\(\)/);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("accepts the macOS ARM64 LLVM target", () => {
    const result = runNodeScript(tripcScriptPath, [
      "--emit",
      "llvm",
      "test/compiler/llvm/helloWorld.trip",
      "--entry-module",
      "Main",
      "--module-source",
      "Prelude=lib/prelude.trip",
      "--target",
      "arm64-apple-darwin",
      "--emit-main-wrapper",
      "--stdout",
    ]);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /target triple = "arm64-apple-darwin"/);
    assert.match(result.stdout, /define i8 @trip_fn_Main_main\(\)/);
    assert.equal(result.stderr, "");
  });

  it("prints LLVM to stdout", () => {
    const result = runNodeScript(tripcScriptPath, [
      "--emit",
      "llvm",
      "test/compiler/llvm/helloWorld.trip",
      "--entry-module",
      "Main",
      "--module-source",
      "Prelude=lib/prelude.trip",
      "--stdout",
    ]);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /define i8 @trip_fn_Main_main\(\)/);
    assert.equal(result.stderr, "");
  });

  it("emits LLVM from a bundle-v1 input", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "typed-ski-tripc-bundle-v1-"));
    try {
      const bundlePath = join(tempDir, "compiler.bundle-v1");
      writeFileSync(
        bundlePath,
        serializeTripBundleV1({
          entryModule: "Main",
          target: { kind: "x86_64-unknown-linux-gnu" },
          mainWrapper: { kind: "c-main" },
          modules: [
            {
              name: "Main",
              source: `module Main
export main
poly main = #u8(7)
`,
            },
          ],
        }),
      );

      const result = runNodeScript(tripcScriptPath, [
        "--bundle-v1",
        bundlePath,
        "--stdout",
      ]);

      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /target triple = "x86_64-unknown-linux-gnu"/);
      assert.match(result.stdout, /define i8 @trip_fn_Main_main\(\)/);
      assert.match(result.stdout, /define i32 @main\(\)/);
      assert.equal(result.stderr, "");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
