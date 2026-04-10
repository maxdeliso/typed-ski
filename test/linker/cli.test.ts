/**
 * Tests for the TripLang Linker CLI
 *
 * This test suite validates the command-line interface including:
 * - Argument parsing
 * - Help and version output
 * - File validation
 * - Error handling
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
  "A.trip",
  "cli_A.tripc",
  "cli_B.tripc",
  "cli_complex.tripc",
  "cli_helper.trip",
  "cli_helper.tripc",
  "cli_temp.txt",
] as const;

describe("TripLang Linker CLI", { concurrency: false }, () => {
  let workspacePath: string | null = null;

  beforeEach(async () => {
    workspacePath = await createTempWorkspace("typed-ski-linker-cli-");
    await copyFixtures(__dirname, workspacePath, FIXTURE_FILES);
  });

  afterEach(async () => {
    await cleanupTempWorkspace(workspacePath);
    workspacePath = null;
  });

  function runLinkerCli(args: string[]) {
    if (workspacePath === null) {
      throw new Error("Expected test workspace to be prepared");
    }
    return runTripcSync(["--link", ...args], {
      cwd: workspacePath,
    });
  }

  it("shows help message", () => {
    const { stdout, status: code } = runLinkerCli(["--help"]);

    assert.strictEqual(code, 0);
    assert.ok(stdout.includes("TripLang Compiler & Linker"));
    assert.ok(stdout.includes("USAGE:"));
    assert.ok(stdout.includes("OPTIONS:"));
    assert.ok(stdout.includes("EXAMPLES:"));
  });

  it("shows version information", () => {
    const { stdout, status: code } = runLinkerCli(["--version"]);

    assert.strictEqual(code, 0);
    assert.match(stdout.trim(), /^tripc v\d+\.\d+\.\d+$/);
  });

  it("accepts short help flag", () => {
    const { stdout, status: code } = runLinkerCli(["-h"]);

    assert.strictEqual(code, 0);
    assert.ok(stdout.includes("TripLang Compiler & Linker"));
  });

  it("accepts short version flag", () => {
    const { stdout, status: code } = runLinkerCli(["-v"]);

    assert.strictEqual(code, 0);
    assert.match(stdout.trim(), /^tripc v\d+\.\d+\.\d+$/);
  });

  it("accepts verbose flag", () => {
    const {
      stdout,
      stderr,
      status: code,
    } = runLinkerCli(["--verbose", "cli_A.tripc"]);

    assert.strictEqual(code, 0);
    assert.strictEqual(typeof stdout, "string");
    assert.ok(stderr.includes("Linking"));
  });

  it("accepts short verbose flag", () => {
    const {
      stdout,
      stderr,
      status: code,
    } = runLinkerCli(["-V", "cli_A.tripc"]);

    assert.strictEqual(code, 0);
    assert.strictEqual(typeof stdout, "string");
    assert.ok(stderr.includes("Linking"));
  });

  it("links single .tripc file", () => {
    const { stdout, status: code } = runLinkerCli(["cli_A.tripc"]);

    assert.strictEqual(code, 0);
    assert.strictEqual(typeof stdout, "string");
    assert.ok(stdout.length > 0);
  });

  it("links multiple .tripc files", () => {
    const { stdout, status: code } = runLinkerCli([
      "cli_A.tripc",
      "cli_helper.tripc",
    ]);

    assert.strictEqual(code, 0);
    assert.strictEqual(typeof stdout, "string");
    assert.ok(stdout.length > 0);
  });

  it("links complex expression", () => {
    const { stdout, status: code } = runLinkerCli(["cli_complex.tripc"]);

    assert.strictEqual(code, 0);
    assert.ok(stdout.includes("K"));
    assert.doesNotThrow(() => parseSKI(stdout.trim()));
  });

  it("rejects non-.tripc files", () => {
    const { stderr, status: code } = runLinkerCli(["A.trip"]);

    assert.strictEqual(code, 1);
    assert.ok(stderr.includes("Input file must have .tripc extension"));
  });

  it("rejects non-existent files", () => {
    const { stderr, status: code } = runLinkerCli(["nonexistent.tripc"]);

    assert.strictEqual(code, 1);
    assert.ok(stderr.includes("Input file does not exist"));
  });

  it("rejects empty argument list", () => {
    const { stderr, status: code } = runLinkerCli([]);

    assert.strictEqual(code, 1);
    assert.ok(stderr.includes("No input files specified"));
  });

  it("handles mixed valid and invalid files", () => {
    const { stderr, status: code } = runLinkerCli([
      "cli_A.tripc",
      "cli_temp.txt",
      "cli_B.tripc",
    ]);

    assert.strictEqual(code, 1);
    assert.ok(stderr.includes("Input file must have .tripc extension"));
  });

  it("executable wrapper works", () => {
    const { stdout, status: code } = runLinkerCli(["--help"]);

    assert.strictEqual(code, 0);
    assert.ok(stdout.includes("TripLang Compiler & Linker"));
  });
});
