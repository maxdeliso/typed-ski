/**
 * Stage-0 native verification of the MiniCore/ANF self-host front-half.
 *
 * Compiles `MiniVerify.verifyToAnfText` (plus its transitive .trip deps)
 * via the host LLVM emitter, runs the resulting native exe, and asserts
 * its stdout matches the golden snapshot already pinned by the host
 * MiniCore evaluator test in `minicoreAnf.test.ts`.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "../../util/test_shim.ts";
import { workspaceRoot } from "../../../lib/shared/workspaceRoot.ts";
import {
  compileTripBundleV1ToLlvm,
  serializeTripBundleV1,
} from "../../../lib/compiler/index.ts";
import {
  buildMiniVerifyHarnessSource,
  MINI_VERIFY_MODULE_NAMES,
} from "../minicoreAnfHarness.ts";
import {
  compileLlvmToExecutable,
  compileTripToLlvm,
  loadCommonModules,
  runExecutable,
} from "./nativeHarness.ts";

const GOLDEN_FILE = join(
  workspaceRoot,
  "test",
  "compiler",
  "inputs",
  "minicoreAnf.golden.txt",
);

describe("MiniVerify native self-host", () => {
  it("stage-0 emits a native exe whose ANF rendering matches the host golden", async () => {
    const moduleSources = await loadCommonModules([
      ...MINI_VERIFY_MODULE_NAMES,
    ]);
    const verifySource = buildMiniVerifyHarnessSource("writeAll");

    const llvm = await compileTripToLlvm(verifySource, {
      entryModule: "Verify",
      moduleSources,
      emitMainWrapper: true,
    });

    const tempDir = await mkdtemp(join(tmpdir(), "typed-ski-mini-verify-"));
    try {
      const llPath = join(tempDir, "mini-verify.ll");
      await writeFile(llPath, llvm, "utf8");
      const exePath = await compileLlvmToExecutable(llPath);
      const result = runExecutable(exePath);
      const expected = await readFile(GOLDEN_FILE, "utf8");
      assert.equal(result.status, 0);
      assert.equal(result.stderr, "");
      assert.equal(result.stdout, expected);
    } finally {
      await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("host bundle-v1 path runs the MiniVerify closure against the golden", async () => {
    const moduleSources = await loadCommonModules([
      ...MINI_VERIFY_MODULE_NAMES,
    ]);
    const bundleBytes = serializeTripBundleV1({
      entryModule: "Verify",
      target: { kind: "generic" },
      emitMainWrapper: true,
      modules: [
        ...moduleSources,
        {
          name: "Verify",
          source: buildMiniVerifyHarnessSource("writeAll"),
        },
      ],
    });

    const llvm = compileTripBundleV1ToLlvm(bundleBytes);
    const tempDir = await mkdtemp(
      join(tmpdir(), "typed-ski-mini-verify-bundle-"),
    );
    try {
      const llPath = join(tempDir, "mini-verify-bundle.ll");
      await writeFile(llPath, llvm, "utf8");
      const exePath = await compileLlvmToExecutable(llPath);
      const result = runExecutable(exePath);
      const expected = await readFile(GOLDEN_FILE, "utf8");
      assert.equal(result.status, 0);
      assert.equal(result.stderr, "");
      assert.equal(result.stdout, expected);
    } finally {
      await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  });
});
