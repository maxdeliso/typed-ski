/**
 * CLI integration tests for the LLVM path.
 */

import { describe, it } from "../util/test_shim.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { compileTripSourceToLlvm } from "../../lib/compiler/index.ts";
import { serializeTripBundleV1 } from "../../lib/compiler/bundleV1.ts";
import {
  cleanupTempWorkspace,
  createTempWorkspace,
  jsRoot,
} from "../util/tripcHarness.ts";
import { workspaceRoot } from "../../lib/shared/workspaceRoot.ts";

const HELLO_SOURCE = readFileSync(
  join(workspaceRoot, "test/compiler/llvm/helloWorld.trip"),
  "utf8",
);
const PRELUDE_SOURCE = readFileSync(
  join(workspaceRoot, "lib/prelude.trip"),
  "utf8",
);

function runTripc(args: string[]) {
  return spawnSync(
    process.execPath,
    [
      "--disable-warning=ExperimentalWarning",
      join(jsRoot, "ts_out/bin/tripc.js"),
      ...args,
    ],
    {
      cwd: jsRoot,
      encoding: "utf-8",
      maxBuffer: 16 * 1024 * 1024,
    },
  );
}

describe("CLI Integration", () => {
  it("source CLI output matches the LLVM library path", async () => {
    const workspaceDir = await createTempWorkspace("cli-llvm-integration-");
    try {
      const outPath = join(workspaceDir, "hello.ll");
      const result = runTripc([
        "--emit",
        "llvm",
        "test/compiler/llvm/helloWorld.trip",
        outPath,
        "--entry-module",
        "Main",
        "--module-source",
        "Prelude=lib/prelude.trip",
        "--emit-main-wrapper",
      ]);

      assert.equal(result.status, 0, result.stderr);
      const cliOutput = readFileSync(outPath, "utf8").trimEnd();
      const libOutput = compileTripSourceToLlvm(HELLO_SOURCE, {
        entryModule: "Main",
        moduleSources: [{ name: "Prelude", source: PRELUDE_SOURCE }],
        emitMainWrapper: true,
      });
      assert.equal(cliOutput, libOutput);
    } finally {
      await cleanupTempWorkspace(workspaceDir);
    }
  });

  it("bundle-v1 CLI output lowers directly to LLVM", async () => {
    const workspaceDir = await createTempWorkspace("cli-bundle-integration-");
    try {
      const bundlePath = join(workspaceDir, "hello.bundle-v1");
      writeFileSync(
        bundlePath,
        serializeTripBundleV1({
          entryModule: "Main",
          target: { kind: "x86_64-unknown-linux-gnu" },
          emitMainWrapper: true,
          modules: [
            { name: "Main", source: HELLO_SOURCE },
            { name: "Prelude", source: PRELUDE_SOURCE },
          ],
        }),
      );

      const result = runTripc(["--bundle-v1", bundlePath, "--stdout"]);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /target triple = "x86_64-unknown-linux-gnu"/);
      assert.match(result.stdout, /define i8 @trip_fn_Main_main\(\)/);
    } finally {
      await cleanupTempWorkspace(workspaceDir);
    }
  });
});
