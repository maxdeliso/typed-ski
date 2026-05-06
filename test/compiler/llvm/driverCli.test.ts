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
  it("emits the same LLVM as the compatibility script", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "typed-ski-tripc-llvm-"));
    try {
      const tripcOut = join(tempDir, "tripc.ll");
      const scriptOut = join(tempDir, "script.ll");
      const args = [
        "--input",
        "test/compiler/llvm/helloWorld.trip",
        "--output",
        scriptOut,
        "--entry-module",
        "Main",
        "--module-source",
        "Prelude=lib/prelude.trip",
        "--target",
        "x86_64-unknown-linux-gnu",
        "--emit-main-wrapper",
      ];

      const script = runNodeScript("scripts/trip_to_llvm.ts", args);
      assert.equal(script.status, 0, script.stderr);

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

      assert.equal(
        readFileSync(tripcOut, "utf8"),
        readFileSync(scriptOut, "utf8"),
      );
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
