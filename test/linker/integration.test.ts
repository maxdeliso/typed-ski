/**
 * Integration tests for the TripLang Linker
 *
 * This test suite validates end-to-end workflows including:
 * - Compilation + Linking pipeline
 * - Different expression types
 * - Error scenarios
 * - Performance characteristics
 */

import { afterEach, beforeEach, describe, it } from "../util/test_shim.ts";

import assert from "node:assert/strict";
import {
  cleanupTempWorkspace,
  copyFixtures,
  createTempWorkspace,
  runTripcSync,
} from "../util/tripcHarness.ts";
import { parseSKI } from "../../lib/parser/ski.ts";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_FILES = [
  "int_simple.trip",
  "int_complex.trip",
  "int_mod_a.trip",
  "int_mod_b.trip",
  "int_invalid.trip",
  "int_noMain.trip",
  "int_large.trip",
  "int_exec_wrapper.trip",
] as const;

describe("TripLang Linker Integration", { concurrency: false }, () => {
  let workspacePath: string | null = null;

  beforeEach(async () => {
    workspacePath = await createTempWorkspace("typed-ski-linker-integration-");
    await copyFixtures(__dirname, workspacePath, FIXTURE_FILES);
  });

  afterEach(async () => {
    await cleanupTempWorkspace(workspacePath);
    workspacePath = null;
  });

  function compileTrip(fileName: string, outputTripc?: string) {
    if (workspacePath === null) {
      throw new Error("Expected test workspace to be prepared");
    }
    return runTripcSync(
      [fileName, outputTripc ?? fileName.replace(".trip", ".tripc")],
      {
        cwd: workspacePath,
      },
    );
  }

  function linkTripc(fileNames: string[]) {
    if (workspacePath === null) {
      throw new Error("Expected test workspace to be prepared");
    }
    return runTripcSync(["--link", ...fileNames], {
      cwd: workspacePath,
    });
  }

  it("full pipeline: compile + link simple expression", () => {
    const { status: compileCode } = compileTrip(
      "int_simple.trip",
      "int_simple.tripc",
    );
    assert.strictEqual(compileCode, 0);

    const { stdout, status: linkCode } = linkTripc(["int_simple.tripc"]);

    assert.strictEqual(linkCode, 0);
    assert.strictEqual(stdout.trim(), "(J0V0)");
  });

  it("full pipeline: compile + link complex expression", () => {
    const { status: compileCode } = compileTrip(
      "int_complex.trip",
      "int_complex.tripc",
    );
    assert.strictEqual(compileCode, 0);

    const { stdout, status: linkCode } = linkTripc(["int_complex.tripc"]);

    assert.strictEqual(linkCode, 0);
    assert.doesNotThrow(() => parseSKI(stdout.trim()));
  });

  it("full pipeline: compile + link multiple modules", () => {
    const { status: compileACode } = compileTrip(
      "int_mod_a.trip",
      "int_mod_a.tripc",
    );
    const { status: compileBCode } = compileTrip(
      "int_mod_b.trip",
      "int_mod_b.tripc",
    );

    assert.strictEqual(compileACode, 0);
    assert.strictEqual(compileBCode, 0);

    const { stdout, status: linkCode } = linkTripc([
      "int_mod_a.tripc",
      "int_mod_b.tripc",
    ]);

    assert.strictEqual(linkCode, 0);
    assert.strictEqual(typeof stdout, "string");
    assert.ok(stdout.length > 0);
  });

  it("handles compilation errors gracefully", () => {
    const { stderr, status: compileCode } = compileTrip(
      "int_invalid.trip",
      "int_invalid.tripc",
    );

    assert.notStrictEqual(compileCode, 0);
    assert.ok(stderr.includes("Compilation error"));
  });

  it("handles linking errors gracefully", () => {
    const { status: compileCode } = compileTrip(
      "int_noMain.trip",
      "int_noMain.tripc",
    );
    assert.strictEqual(compileCode, 0);

    const { stderr, status: linkCode } = linkTripc(["int_noMain.tripc"]);

    assert.notStrictEqual(linkCode, 0);
    assert.match(stderr, /No 'main' function found|Symbol.*is not defined/);
  });

  it("performance: handles large expressions", () => {
    const { status: compileCode } = compileTrip(
      "int_large.trip",
      "int_large.tripc",
    );
    assert.strictEqual(compileCode, 0);

    const { stdout, status: linkCode } = linkTripc(["int_large.tripc"]);

    assert.strictEqual(linkCode, 0);
    assert.strictEqual(typeof stdout, "string");
    assert.ok(stdout.length > 0);
  });

  it("executable wrapper integration", () => {
    const { status: compileCode } = compileTrip(
      "int_exec_wrapper.trip",
      "int_exec_wrapper.tripc",
    );
    assert.strictEqual(compileCode, 0);

    const { stdout, status: code } = linkTripc(["int_exec_wrapper.tripc"]);

    assert.strictEqual(code, 0);
    assert.strictEqual(typeof stdout, "string");
    assert.ok(stdout.length > 0);
  });
});
