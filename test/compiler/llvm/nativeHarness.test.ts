import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "../../util/test_shim.ts";
import { compileTripAndRun, macosSdkArgs } from "./nativeHarness.ts";
import { findLocalClangPath } from "../../../lib/shared/clangPath.ts";
import { workspaceRoot } from "../../../lib/shared/workspaceRoot.ts";

async function runRuntimeCTest(cSource: string) {
  const tempDir = await mkdtemp(join(tmpdir(), "trip-runtime-test-"));
  const cPath = join(tempDir, "test.c");
  const exePath = join(
    tempDir,
    process.platform === "win32" ? "test.exe" : "test",
  );
  await writeFile(cPath, cSource, "utf8");

  const CLANG = process.env["TYPED_SKI_CLANG"] ?? findLocalClangPath();
  if (!CLANG) {
    throw new Error("Clang path not found");
  }

  const args = [
    cPath,
    join(workspaceRoot, "runtime/trip/trip_runtime.c"),
    "-I",
    join(workspaceRoot, "runtime/trip"),
    ...macosSdkArgs(),
    "-o",
    exePath,
  ];

  const compileResult = spawnSync(CLANG, args, { encoding: "utf8" });
  if (compileResult.status !== 0) {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    throw new Error(`Clang failed:\n${compileResult.stderr}`);
  }

  const runResult = spawnSync(exePath, [], { encoding: "utf8" });
  await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  return runResult;
}

describe("LLVM native harness", () => {
  it("compiles and runs a simple arithmetic Trip program", async () => {
    const source = `
module Main
import Prelude writeOne
import Prelude U8

export main

poly main = writeOne #u8(42) [U8] (\\x : U8 => x)
`;
    const result = await compileTripAndRun(source);

    assert.equal(result.status, 42);
    assert.equal(result.stdout, "*"); // ASCII 42 is '*'
  });

  it("compiles and runs a program that returns a value to the C wrapper", async () => {
    const source = `
    module Main
    import Prelude U8

    export main

    poly main = #u8(123)
    `;
    // The C main wrapper returns the result of Main.main if it's u8
    const result = await compileTripAndRun(source, { emitMainWrapper: true });

    assert.equal(result.status, 123);
  });

  describe("C runtime trip_obj_tag validation", () => {
    it("returns tag 0 for pointer 1 (false) and tag 1 for pointer 2 (true)", async () => {
      const cSource = `
#include "trip_runtime.h"
#include <assert.h>
int main() {
    assert(trip_obj_tag((const trip_obj_t*)1) == 0);
    assert(trip_obj_tag((const trip_obj_t*)2) == 1);
    return 0;
}
`;
      const result = await runRuntimeCTest(cSource);
      assert.equal(result.status, 0);
    });

    it("aborts on NULL pointer", async () => {
      const cSource = `
#include "trip_runtime.h"
#include <stddef.h>
int main() {
    trip_obj_tag(NULL);
    return 0;
}
`;
      const result = await runRuntimeCTest(cSource);
      assert.ok(result.status !== 0 || result.status === null);
    });

    it("aborts on small invalid pointer 3", async () => {
      const cSource = `
#include "trip_runtime.h"
int main() {
    trip_obj_tag((const trip_obj_t*)3);
    return 0;
}
`;
      const result = await runRuntimeCTest(cSource);
      assert.ok(result.status !== 0 || result.status === null);
    });
  });
});
