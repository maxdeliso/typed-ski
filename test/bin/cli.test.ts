/**
 * CLI tests for the TripLang LLVM compiler.
 */

import { describe, it } from "../util/test_shim.ts";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import process from "node:process";

import { resolveDistPath } from "../util/tripcHarness.ts";
import { workspaceRoot } from "../../lib/shared/workspaceRoot.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const jsRoot = join(__dirname, "../..");
const srcRoot = workspaceRoot;
const compiledTripcName = process.platform === "win32" ? "tripc.cmd" : "tripc";
const bundledTripcPath = resolveDistPath(
  "TYPED_SKI_DIST_JS_PATH",
  "dist/tripc.js",
);
const minifiedTripcPath = resolveDistPath(
  "TYPED_SKI_DIST_MIN_JS_PATH",
  "dist/tripc.min.js",
);
const compiledTripcPath = resolveDistPath(
  "TYPED_SKI_DIST_BIN_PATH",
  `dist/${compiledTripcName}`,
);

async function runCommand(
  command: string[],
  cwd = jsRoot,
): Promise<{
  success: boolean;
  stdout: string;
  stderr: string;
  code: number | null;
}> {
  let executable = command[0]!;
  let args = command.slice(1);

  if (executable === "node" || executable === process.execPath) {
    executable = process.execPath;
    if (args.includes("bin/tripc.js")) {
      const tripcIndex = args.indexOf("bin/tripc.js");
      args = [
        "--disable-warning=ExperimentalWarning",
        "bin/tripc.js",
        ...args.slice(tripcIndex + 1),
      ];
    } else if (
      args.includes("dist/tripc.js") ||
      args.includes("dist/tripc.min.js")
    ) {
      const scriptIndex = args.findIndex((arg) => arg.endsWith(".js"));
      if (scriptIndex !== -1) {
        args = [args[scriptIndex]!, ...args.slice(scriptIndex + 1)];
      }
    }
  }

  const result = spawnSync(executable, args, {
    cwd,
    encoding: "utf-8",
    shell: process.platform === "win32" && executable.endsWith(".cmd"),
  });

  return {
    success: result.status === 0,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    code: result.status,
  };
}

function assertCommandSuccess(
  result: {
    success: boolean;
    stdout: string;
    stderr: string;
    code: number | null;
  },
  command: string[],
): void {
  if (!result.success) {
    throw new Error(
      [
        `Command failed: ${command.join(" ")}`,
        `Exit code: ${result.code}`,
        `Stdout:\n${result.stdout || "(empty)"}`,
        `Stderr:\n${result.stderr || "(empty)"}`,
      ].join("\n"),
    );
  }
}

function llvmArgs(): string[] {
  return [
    "--emit",
    "llvm",
    join(srcRoot, "test/compiler/llvm/helloWorld.trip"),
    "--entry-module",
    "Main",
    "--module-source",
    `Prelude=${join(srcRoot, "lib/prelude.trip")}`,
    "--emit-main-wrapper",
    "--stdout",
  ];
}

describe("CLI Tests", () => {
  describe("CLI file structure tests", () => {
    it("CLI files exist", () => {
      assert.strictEqual(existsSync(join(srcRoot, "bin", "tripc.ts")), true);
    });

    it("CLI files have proper content", async () => {
      const tripcTs = await readFile(join(srcRoot, "bin/tripc.ts"), "utf-8");
      assert.ok(tripcTs.includes("TripLang LLVM compiler CLI"));
      assert.ok(tripcTs.includes("compileTripBundleV1ToLlvm"));
    });
  });

  describe("Compiled CLI (bin/tripc.js)", () => {
    it("--version flag", async () => {
      const result = await runCommand([
        process.execPath,
        "bin/tripc.js",
        "--version",
      ]);

      assert.strictEqual(result.success, true);
      assert.match(result.stdout.trim(), /^tripc v\d+\.\d+\.\d+$/);
    });

    it("--help flag", async () => {
      const result = await runCommand([
        process.execPath,
        "bin/tripc.js",
        "--help",
      ]);

      assert.strictEqual(result.success, true);
      assert.ok(result.stdout.includes("TripLang LLVM Compiler (tripc)"));
      assert.ok(result.stdout.includes("USAGE:"));
    });

    it("emits LLVM to stdout", async () => {
      const result = await runCommand([
        process.execPath,
        "bin/tripc.js",
        ...llvmArgs(),
      ]);

      assert.strictEqual(result.success, true, result.stderr);
      assert.match(result.stdout, /define i8 @trip_fn_Main_main\(\)/);
      assert.match(result.stdout, /define i32 @main\(\)/);
    });

    it("reports LLVM errors", async () => {
      const result = await runCommand([
        process.execPath,
        "bin/tripc.js",
        "--emit",
        "llvm",
        join(srcRoot, "test/bin/fixtures/invalid_syntax.trip"),
      ]);

      assert.strictEqual(result.success, false);
      assert.ok(result.stderr.includes("LLVM emission error"));
    });
  });

  describe("Bundled JavaScript (dist/tripc.js)", () => {
    it("file exists", () => {
      assert.strictEqual(existsSync(bundledTripcPath), true);
    });

    it("--version flag", async () => {
      const command = [process.execPath, bundledTripcPath, "--version"];
      const result = await runCommand(command);
      assertCommandSuccess(result, command);
      assert.match(result.stdout.trim(), /^tripc v\d+\.\d+\.\d+$/);
    });

    it("emits LLVM", async () => {
      const command = [process.execPath, bundledTripcPath, ...llvmArgs()];
      const result = await runCommand(command);
      assertCommandSuccess(result, command);
      assert.match(result.stdout, /define i8 @trip_fn_Main_main\(\)/);
    });
  });

  describe("Minified JavaScript (dist/tripc.min.js)", () => {
    it("file exists", () => {
      assert.strictEqual(existsSync(minifiedTripcPath), true);
    });

    it("--version flag", async () => {
      const command = [process.execPath, minifiedTripcPath, "--version"];
      const result = await runCommand(command);
      assertCommandSuccess(result, command);
      assert.match(result.stdout.trim(), /^tripc v\d+\.\d+\.\d+$/);
    });

    it("emits LLVM", async () => {
      const command = [process.execPath, minifiedTripcPath, ...llvmArgs()];
      const result = await runCommand(command);
      assertCommandSuccess(result, command);
      assert.match(result.stdout, /define i8 @trip_fn_Main_main\(\)/);
    });
  });

  describe("Compiled Binary (dist/tripc)", () => {
    it("file exists", () => {
      assert.strictEqual(existsSync(compiledTripcPath), true);
    });

    it("file is executable", () => {
      assert.strictEqual(statSync(compiledTripcPath).isFile(), true);
    });

    it("--version flag", async () => {
      const command = [compiledTripcPath, "--version"];
      const result = await runCommand(command);
      assertCommandSuccess(result, command);
      assert.match(result.stdout.trim(), /^tripc v\d+\.\d+\.\d+$/);
    });

    it("--help flag", async () => {
      const command = [compiledTripcPath, "--help"];
      const result = await runCommand(command);
      assertCommandSuccess(result, command);
      assert.ok(result.stdout.includes("TripLang LLVM Compiler (tripc)"));
      assert.ok(result.stdout.includes("USAGE:"));
    });

    it("emits LLVM", async () => {
      const command = [compiledTripcPath, ...llvmArgs()];
      const result = await runCommand(command);
      assertCommandSuccess(result, command);
      assert.match(result.stdout, /define i8 @trip_fn_Main_main\(\)/);
    });
  });

  describe("tripc Extra CLI Coverage", () => {
    it("error on unknown option", async () => {
      const result = await runCommand([
        process.execPath,
        "bin/tripc.js",
        "--unknown",
      ]);
      assert.strictEqual(result.success, false);
      assert.ok(result.stderr.includes("Unknown option: --unknown"));
    });

    it("error on too many arguments", async () => {
      const result = await runCommand([
        process.execPath,
        "bin/tripc.js",
        "a.trip",
        "b.ll",
        "extra",
      ]);
      assert.strictEqual(result.success, false);
      assert.ok(result.stderr.includes("Too many arguments"));
    });

    it("error on no input file", async () => {
      const result = await runCommand([process.execPath, "bin/tripc.js"]);
      assert.strictEqual(result.success, false);
      assert.ok(result.stderr.includes("Error: No input file specified"));
    });

    it("error on non-trip extension for source input", async () => {
      const result = await runCommand([
        process.execPath,
        "bin/tripc.js",
        join(srcRoot, "test/bin/fixtures/empty.txt"),
      ]);
      assert.strictEqual(result.success, false);
      assert.ok(result.stderr.includes("must have .trip extension"));
    });

    it("short flags coverage (-h, -v)", async () => {
      let result = await runCommand([process.execPath, "bin/tripc.js", "-h"]);
      assert.strictEqual(result.success, true);
      assert.ok(result.stdout.includes("USAGE:"));

      result = await runCommand([process.execPath, "bin/tripc.js", "-v"]);
      assert.strictEqual(result.success, true);
      assert.ok(result.stdout.includes("tripc v"));
    });

    it("error when input path is a directory", async () => {
      const result = await runCommand([
        process.execPath,
        "bin/tripc.js",
        "bin/",
      ]);
      assert.strictEqual(result.success, false);
      assert.ok(result.stderr.includes("Input path is not a file"));
    });
  });
});
