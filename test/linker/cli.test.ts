/**
 * Tests for the TripLang Linker CLI
 *
 * This test suite validates the command-line interface including:
 * - Argument parsing
 * - Help and version output
 * - File validation
 * - Error handling
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

    expect(code).to.equal(0);
    expect(stdout).to.include("TripLang Compiler & Linker");
    expect(stdout).to.include("USAGE:");
    expect(stdout).to.include("OPTIONS:");
    expect(stdout).to.include("EXAMPLES:");
  });

  it("shows version information", () => {
    const { stdout, status: code } = runLinkerCli(["--version"]);

    expect(code).to.equal(0);
    expect(stdout.trim()).to.match(/^tripc v\d+\.\d+\.\d+$/);
  });

  it("accepts short help flag", () => {
    const { stdout, status: code } = runLinkerCli(["-h"]);

    expect(code).to.equal(0);
    expect(stdout).to.include("TripLang Compiler & Linker");
  });

  it("accepts short version flag", () => {
    const { stdout, status: code } = runLinkerCli(["-v"]);

    expect(code).to.equal(0);
    expect(stdout.trim()).to.match(/^tripc v\d+\.\d+\.\d+$/);
  });

  it("accepts verbose flag", () => {
    const {
      stdout,
      stderr,
      status: code,
    } = runLinkerCli(["--verbose", "cli_A.tripc"]);

    expect(code).to.equal(0);
    expect(stdout).to.be.a("string");
    expect(stderr).to.include("Linking");
  });

  it("accepts short verbose flag", () => {
    const {
      stdout,
      stderr,
      status: code,
    } = runLinkerCli(["-V", "cli_A.tripc"]);

    expect(code).to.equal(0);
    expect(stdout).to.be.a("string");
    expect(stderr).to.include("Linking");
  });

  it("links single .tripc file", () => {
    const { stdout, status: code } = runLinkerCli(["cli_A.tripc"]);

    expect(code).to.equal(0);
    expect(stdout).to.be.a("string");
    expect(stdout.length).to.be.greaterThan(0);
  });

  it("links multiple .tripc files", () => {
    const { stdout, status: code } = runLinkerCli([
      "cli_A.tripc",
      "cli_helper.tripc",
    ]);

    expect(code).to.equal(0);
    expect(stdout).to.be.a("string");
    expect(stdout.length).to.be.greaterThan(0);
  });

  it("links complex expression", () => {
    const { stdout, status: code } = runLinkerCli(["cli_complex.tripc"]);

    expect(code).to.equal(0);
    expect(stdout).to.include("K");
    expect(() => parseSKI(stdout.trim())).to.not.throw();
  });

  it("rejects non-.tripc files", () => {
    const { stderr, status: code } = runLinkerCli(["A.trip"]);

    expect(code).to.equal(1);
    expect(stderr).to.include("Input file must have .tripc extension");
  });

  it("rejects non-existent files", () => {
    const { stderr, status: code } = runLinkerCli(["nonexistent.tripc"]);

    expect(code).to.equal(1);
    expect(stderr).to.include("Input file does not exist");
  });

  it("rejects empty argument list", () => {
    const { stderr, status: code } = runLinkerCli([]);

    expect(code).to.equal(1);
    expect(stderr).to.include("No input files specified");
  });

  it("handles mixed valid and invalid files", () => {
    const { stderr, status: code } = runLinkerCli([
      "cli_A.tripc",
      "cli_temp.txt",
      "cli_B.tripc",
    ]);

    expect(code).to.equal(1);
    expect(stderr).to.include("Input file must have .tripc extension");
  });

  it("executable wrapper works", () => {
    const { stdout, status: code } = runLinkerCli(["--help"]);

    expect(code).to.equal(0);
    expect(stdout).to.include("TripLang Compiler & Linker");
  });
});
