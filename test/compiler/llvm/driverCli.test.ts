import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "../../util/test_shim.ts";
import { projectRoot, tripcScriptPath } from "../../util/tripcHarness.ts";

function runNodeScript(script: string, args: string[]) {
  return spawnSync(
    process.execPath,
    [
      "--disable-warning=ExperimentalWarning",
      "--experimental-transform-types",
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
      assert.match(outContent, /define i8 @trip_fn_Main_main\(\)/);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
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
});
