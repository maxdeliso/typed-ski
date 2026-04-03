/**
 * Integration tests for the TripLang Linker
 *
 * This test suite validates end-to-end workflows including:
 * - Compilation + Linking pipeline
 * - Different expression types
 * - Error scenarios
 * - Performance characteristics
 */

import { afterEach, beforeEach, describe, it } from "node:test";

import { expect } from "../util/assertions.ts";
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
    expect(compileCode).to.equal(0);

    const { stdout, status: linkCode } = linkTripc(["int_simple.tripc"]);

    expect(linkCode).to.equal(0);
    expect(stdout.trim()).to.equal("I");
  });

  it("full pipeline: compile + link complex expression", () => {
    const { status: compileCode } = compileTrip(
      "int_complex.trip",
      "int_complex.tripc",
    );
    expect(compileCode).to.equal(0);

    const { stdout, status: linkCode } = linkTripc(["int_complex.tripc"]);

    expect(linkCode).to.equal(0);
    expect(stdout).to.include("K");
    expect(() => parseSKI(stdout.trim())).to.not.throw();
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

    expect(compileACode).to.equal(0);
    expect(compileBCode).to.equal(0);

    const { stdout, status: linkCode } = linkTripc([
      "int_mod_a.tripc",
      "int_mod_b.tripc",
    ]);

    expect(linkCode).to.equal(0);
    expect(stdout).to.be.a("string");
    expect(stdout.length).to.be.greaterThan(0);
  });

  it("handles compilation errors gracefully", () => {
    const { stderr, status: compileCode } = compileTrip(
      "int_invalid.trip",
      "int_invalid.tripc",
    );

    expect(compileCode).to.not.equal(0);
    expect(stderr).to.include("Compilation error");
  });

  it("handles linking errors gracefully", () => {
    const { status: compileCode } = compileTrip(
      "int_noMain.trip",
      "int_noMain.tripc",
    );
    expect(compileCode).to.equal(0);

    const { stderr, status: linkCode } = linkTripc(["int_noMain.tripc"]);

    expect(linkCode).to.not.equal(0);
    expect(stderr).to.match(/No 'main' function found|Symbol.*is not defined/);
  });

  it("performance: handles large expressions", () => {
    const { status: compileCode } = compileTrip(
      "int_large.trip",
      "int_large.tripc",
    );
    expect(compileCode).to.equal(0);

    const { stdout, status: linkCode } = linkTripc(["int_large.tripc"]);

    expect(linkCode).to.equal(0);
    expect(stdout).to.be.a("string");
    expect(stdout.length).to.be.greaterThan(0);
  });

  it("executable wrapper integration", () => {
    const { status: compileCode } = compileTrip(
      "int_exec_wrapper.trip",
      "int_exec_wrapper.tripc",
    );
    expect(compileCode).to.equal(0);

    const { stdout, status: code } = linkTripc(["int_exec_wrapper.tripc"]);

    expect(code).to.equal(0);
    expect(stdout).to.be.a("string");
    expect(stdout.length).to.be.greaterThan(0);
  });
});
