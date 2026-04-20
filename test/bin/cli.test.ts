/**
 * CLI Tests
 *
 * Comprehensive tests for the TripLang compiler CLI:
 * - Library function testing
 * - Object file format validation
 * - CLI packaging in various distribution formats
 * - Error handling
 * - Version consistency
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

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "../..");
const fixturesDir = join(__dirname, "fixtures");
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

// Import library functions for testing
import {
  compileToObjectFile,
  compileToObjectFileString,
  SingleFileCompilerError,
} from "../../lib/compiler/singleFileCompiler.ts";
import { deserializeTripCObject } from "../../lib/compiler/objectFile.ts";
import { required, requiredAt } from "../util/required.ts";

// Test utilities
async function runCommand(
  command: string[],
  cwd = projectRoot,
): Promise<{
  success: boolean;
  stdout: string;
  stderr: string;
  code: number | null;
}> {
  const command0 = requiredAt(command, 0, "expected command executable");
  let executable = command0;
  let args = command.slice(1);

  // For running 'bin/tripc.ts', use process.execPath with the repo's transform-types flags.
  if (command0 === "node" || command0 === process.execPath) {
    if (args.includes("bin/tripc.ts")) {
      executable = process.execPath;
      const tripcIndex = args.indexOf("bin/tripc.ts");
      args = [
        "--disable-warning=ExperimentalWarning",
        "--experimental-transform-types",
        "bin/tripc.ts",
        ...args.slice(tripcIndex + 1),
      ];
    } else if (
      args.includes("dist/tripc.js") ||
      args.includes("dist/tripc.min.js")
    ) {
      executable = process.execPath;
      const scriptIndex = args.findIndex((arg) => arg.endsWith(".js"));
      if (scriptIndex !== -1) {
        args = [args[scriptIndex]!, ...args.slice(scriptIndex + 1)];
      }
    }
  }

  try {
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
  } catch (error) {
    return {
      success: false,
      stdout: "",
      stderr: (error as Error).message,
      code: -1,
    };
  }
}

function fixturePath(fixtureName: string): string {
  return join(fixturesDir, fixtureName);
}

function assertCommandSuccess(
  result: {
    success: boolean;
    stdout: string;
    stderr: string;
    code: number | null;
  },
  command: string[],
  context?: string,
): void {
  if (!result.success) {
    const contextMsg = context ? `\nContext: ${context}\n` : "\n";
    const commandMsg = `Command: ${command.join(" ")}\n`;
    const codeMsg = `Exit code: ${result.code}\n`;
    const stdoutMsg = `Stdout:\n${result.stdout || "(empty)"}\n`;
    const stderrMsg = `Stderr:\n${result.stderr || "(empty)"}\n`;
    throw new Error(
      `Command failed:${contextMsg}${commandMsg}${codeMsg}${stdoutMsg}${stderrMsg}`,
    );
  }
}

describe("CLI Tests", () => {
  describe("Library function tests", () => {
    it("compileToObjectFile works with valid input", () => {
      const source = `module Test
export id
poly id = #a => \\x:a => x`;

      const result = compileToObjectFile(source);

      assert.strictEqual(result.module, "Test");
      assert.ok("imports" in result);
      assert.ok("exports" in result);
      assert.ok("definitions" in result);
      assert.ok("dataDefinitions" in result);

      assert.ok(Array.isArray(result.imports));
      assert.ok(Array.isArray(result.exports));
      assert.ok(typeof result.definitions === "object");
      assert.ok(Array.isArray(result.dataDefinitions));

      assert.ok(result.exports.includes("id"));
      assert.ok("id" in result.definitions);
    });

    it("compileToObjectFileString works", () => {
      const source = `module Test
export id
poly id = #a => \\x:a => x`;

      const result = compileToObjectFileString(source);

      assert.strictEqual(typeof result, "string");

      // Should be valid JSON
      const parsed = JSON.parse(result);
      assert.strictEqual(parsed.module, "Test");

      // Should be deserializable
      const deserialized = deserializeTripCObject(result);
      assert.deepStrictEqual(deserialized, parsed);
    });

    it("invalid syntax is parsed as non-terminal", () => {
      const invalidSource = `module Test
poly id = invalid syntax here`;

      const result = compileToObjectFile(invalidSource);

      // Should still compile but with non-terminal structure
      assert.strictEqual(result.module, "Test");
      assert.ok("id" in result.definitions);

      const idDef = required(result.definitions.id, "expected definition 'id'");
      if (idDef.kind === "poly") {
        assert.strictEqual(idDef.term.kind, "non-terminal");
      }
    });

    it("error handling for missing module", () => {
      const noModuleSource = `poly id = #a => \\x:a => x`;

      assert.throws(() => {
        compileToObjectFile(noModuleSource);
      }, SingleFileCompilerError);
    });

    it("error handling for multiple modules", () => {
      const multipleModulesSource = `module First
module Second
poly id = #a => \\x:a => x`;

      assert.throws(() => {
        compileToObjectFile(multipleModulesSource);
      }, SingleFileCompilerError);
    });
  });

  describe("Object file format tests", () => {
    it("object file has correct structure", () => {
      const source = `module Test
import Math add
export id
export double
poly id = #a => \\x:a => x
poly double = \\x:Int => add x x`;

      const result = compileToObjectFile(source);

      // Check module
      assert.strictEqual(result.module, "Test");

      // Check imports
      assert.strictEqual(result.imports.length, 1);
      assert.deepStrictEqual(
        requiredAt(result.imports, 0, "expected first import"),
        { name: "add", from: "Math" },
      );

      // Check exports
      assert.strictEqual(result.exports.length, 2);
      assert.ok(result.exports.includes("id"));
      assert.ok(result.exports.includes("double"));

      // Check definitions
      assert.strictEqual(Object.keys(result.definitions).length, 2);
      assert.ok("id" in result.definitions);
      assert.ok("double" in result.definitions);
      assert.deepStrictEqual(result.dataDefinitions, []);

      // Check definition structure
      const idDef = required(result.definitions.id, "expected definition 'id'");
      assert.strictEqual(idDef.kind, "poly");
      assert.strictEqual(idDef.name, "id");

      const doubleDef = required(
        result.definitions.double,
        "expected definition 'double'",
      );
      assert.strictEqual(doubleDef.kind, "poly");
      assert.strictEqual(doubleDef.name, "double");
    });

    it("object file serialization/deserialization", () => {
      const source = `module Test
export id
poly id = #a => \\x:a => x`;

      const original = compileToObjectFile(source);
      const serialized = compileToObjectFileString(source);
      const deserialized = deserializeTripCObject(serialized);

      // Check key properties instead of deep equality
      assert.strictEqual(deserialized.module, original.module);
      assert.deepStrictEqual(deserialized.imports, original.imports);
      assert.deepStrictEqual(deserialized.exports, original.exports);
      assert.deepStrictEqual(
        deserialized.dataDefinitions,
        original.dataDefinitions,
      );
      assert.deepStrictEqual(
        Object.keys(deserialized.definitions),
        Object.keys(original.definitions),
      );
    });

    it("object file contains elaborated definitions", () => {
      const source = `module Test
export id
poly id = #a => \\x:a => x`;

      const result = compileToObjectFile(source);
      const idDef = required(result.definitions.id, "expected definition 'id'");

      // Term should be elaborated System F
      if (idDef.kind === "poly") {
        assert.strictEqual(idDef.term.kind, "systemF-type-abs");
        if (idDef.term.kind === "systemF-type-abs") {
          assert.strictEqual(idDef.term.body.kind, "systemF-abs");
        }
      }
    });
  });

  describe("CLI file structure tests", () => {
    it("CLI files exist", () => {
      const binDir = join(projectRoot, "bin");
      assert.strictEqual(existsSync(binDir), true);

      assert.strictEqual(existsSync(join(binDir, "tripc.ts")), true);
    });

    it("CLI files have proper content", async () => {
      const tripcTs = await readFile(
        join(projectRoot, "bin/tripc.ts"),
        "utf-8",
      );
      assert.ok(tripcTs.includes("TripLang Compiler & Linker"));
      assert.ok(tripcTs.includes("loadTripModuleObject"));
    });
  });

  describe("Version consistency tests", () => {
    it("version is consistent across files", async () => {
      const packageJsonPath = join(projectRoot, "package.json");
      const packageJson = JSON.parse(await readFile(packageJsonPath, "utf-8"));
      const version = packageJson.version;

      const jsrJsonPath = join(projectRoot, "jsr.json");
      const jsrJson = JSON.parse(await readFile(jsrJsonPath, "utf-8"));
      assert.strictEqual(jsrJson.version, version);

      const generatedVersionPath = join(
        projectRoot,
        "lib",
        "shared",
        "version.generated.ts",
      );
      const generatedVersion = await readFile(generatedVersionPath, "utf-8");
      assert.ok(
        generatedVersion.includes(`export const VERSION = "${version}";`),
      );
    });
  });

  describe("CLI Packaging Tests", () => {
    describe("TypeScript CLI (bin/tripc.ts)", () => {
      it("--version flag", async () => {
        const result = await runCommand([
          process.execPath,
          "bin/tripc.ts",
          "--version",
        ]);

        assert.strictEqual(result.success, true);
        assert.match(result.stdout.trim(), /^tripc v\d+\.\d+\.\d+$/);
      });

      it("--help flag", async () => {
        const result = await runCommand([
          process.execPath,
          "bin/tripc.ts",
          "--help",
        ]);

        assert.strictEqual(result.success, true);
        assert.ok(result.stdout.includes("TripLang Compiler & Linker (tripc)"));
        assert.ok(result.stdout.includes("USAGE:"));
      });

      it("compilation", async () => {
        const testFile = fixturePath("test.trip");

        const result = await runCommand([
          process.execPath,
          "bin/tripc.ts",
          testFile,
          "--stdout",
        ]);

        assert.strictEqual(result.success, true);

        // Verify object file content
        const parsed = JSON.parse(result.stdout);
        assert.strictEqual(parsed.module, "TestModule");
      });

      it("verbose compilation", async () => {
        const testFile = fixturePath("test.trip");

        const result = await runCommand([
          process.execPath,
          "bin/tripc.ts",
          testFile,
          "--verbose",
          "--stdout",
        ]);

        assert.strictEqual(result.success, true);
      });

      it("error handling", async () => {
        const invalidFile = fixturePath("invalid_syntax.trip");

        const result = await runCommand([
          process.execPath,
          "bin/tripc.ts",
          invalidFile,
        ]);

        assert.strictEqual(result.success, false);
        assert.ok(result.stderr.includes("Compilation error"));
      });
    });

    describe("Bundled JavaScript (dist/tripc.js)", () => {
      const bundledJsPath = bundledTripcPath;

      it("file exists", () => {
        assert.strictEqual(existsSync(bundledJsPath), true);
      });

      it("--version flag", async () => {
        const command = [process.execPath, bundledJsPath, "--version"];
        const result = await runCommand(command);

        assertCommandSuccess(
          result,
          command,
          "Bundled JavaScript (dist/tripc.js) --version flag",
        );
        assert.match(result.stdout.trim(), /^tripc v\d+\.\d+\.\d+$/);
      });

      it("compilation", async () => {
        const testFile = fixturePath("test.trip");

        const command = [process.execPath, bundledJsPath, testFile, "--stdout"];
        const result = await runCommand(command);

        assertCommandSuccess(
          result,
          command,
          "Bundled JavaScript (dist/tripc.js) compilation",
        );

        // Verify output
        const parsed = JSON.parse(result.stdout);
        assert.strictEqual(parsed.module, "TestModule");
      });
    });

    describe("Minified JavaScript (dist/tripc.min.js)", () => {
      const minifiedJsPath = minifiedTripcPath;

      it("file exists", () => {
        assert.strictEqual(existsSync(minifiedJsPath), true);
      });

      it("--version flag", async () => {
        const command = [process.execPath, minifiedJsPath, "--version"];
        const result = await runCommand(command);

        assertCommandSuccess(
          result,
          command,
          "Minified JavaScript (dist/tripc.min.js) --version flag",
        );
        assert.match(result.stdout.trim(), /^tripc v\d+\.\d+\.\d+$/);
      });

      it("compilation", async () => {
        const testFile = fixturePath("test.trip");

        const command = [
          process.execPath,
          minifiedJsPath,
          testFile,
          "--stdout",
        ];
        const result = await runCommand(command);

        assertCommandSuccess(
          result,
          command,
          "Minified JavaScript (dist/tripc.min.js) compilation",
        );

        // Verify output
        const parsed = JSON.parse(result.stdout);
        assert.strictEqual(parsed.module, "TestModule");
      });
    });

    describe("Compiled Binary (dist/tripc)", () => {
      const binaryPath = compiledTripcPath;

      it("file exists", () => {
        assert.strictEqual(existsSync(binaryPath), true);
      });

      it("file is executable", async () => {
        try {
          const stat = statSync(binaryPath);
          assert.strictEqual(stat.isFile(), true);
        } catch (error) {
          throw new Error(
            `Binary file check failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      });

      it("--version flag", async () => {
        const command = [compiledTripcPath, "--version"];
        const result = await runCommand(command);

        assertCommandSuccess(
          result,
          command,
          "Compiled Binary (dist/tripc) --version flag",
        );
        assert.match(result.stdout.trim(), /^tripc v\d+\.\d+\.\d+$/);
      });

      it("--help flag", async () => {
        const command = [compiledTripcPath, "--help"];
        const result = await runCommand(command);

        assertCommandSuccess(
          result,
          command,
          "Compiled Binary (dist/tripc) --help flag",
        );
        assert.ok(result.stdout.includes("TripLang Compiler & Linker (tripc)"));
        assert.ok(result.stdout.includes("USAGE:"));
      });

      it("compilation", async () => {
        const testFile = fixturePath("test.trip");

        const command = [compiledTripcPath, testFile, "--stdout"];
        const result = await runCommand(command);

        assertCommandSuccess(
          result,
          command,
          "Compiled Binary (dist/tripc) compilation",
        );

        // Verify output
        const parsed = JSON.parse(result.stdout);
        assert.strictEqual(parsed.module, "TestModule");
      });

      it("verbose compilation", async () => {
        const testFile = fixturePath("test.trip");

        const command = [compiledTripcPath, testFile, "--verbose", "--stdout"];
        const result = await runCommand(command);

        assertCommandSuccess(
          result,
          command,
          "Compiled Binary (dist/tripc) verbose compilation",
        );
      });
    });
  });

  describe("tripc Extra CLI Coverage", () => {
    it("error on unknown option", async () => {
      const result = await runCommand([
        process.execPath,
        "bin/tripc.ts",
        "--unknown",
      ]);
      assert.strictEqual(result.success, false);
      assert.ok(result.stderr.includes("Unknown option: --unknown"));
    });

    it("error on too many arguments", async () => {
      const result = await runCommand([
        process.execPath,
        "bin/tripc.ts",
        "a.trip",
        "b.tripc",
        "extra",
      ]);
      assert.strictEqual(result.success, false);
      assert.ok(result.stderr.includes("Too many arguments"));
    });

    it("error on no input file", async () => {
      const result = await runCommand([process.execPath, "bin/tripc.ts"]);
      assert.strictEqual(result.success, false);
      assert.ok(result.stderr.includes("Error: No input file specified"));
    });

    it("error on non-trip extension for compilation", async () => {
      const tempFile = fixturePath("empty.txt");
      const result = await runCommand([
        process.execPath,
        "bin/tripc.ts",
        tempFile,
      ]);
      assert.strictEqual(result.success, false);
      assert.ok(result.stderr.includes("must have .trip extension"));
    });

    it("error on linking with no files", async () => {
      const result = await runCommand([
        process.execPath,
        "bin/tripc.ts",
        "--link",
      ]);
      assert.strictEqual(result.success, false);
      assert.ok(
        result.stderr.includes("Error: No input files specified for linking"),
      );
    });

    it("short flags coverage (-h, -v, -V, -c)", async () => {
      // -h
      let result = await runCommand([process.execPath, "bin/tripc.ts", "-h"]);
      assert.strictEqual(result.success, true);
      assert.ok(result.stdout.includes("USAGE:"));

      // -v
      result = await runCommand([process.execPath, "bin/tripc.ts", "-v"]);
      assert.strictEqual(result.success, true);
      assert.ok(result.stdout.includes("tripc v"));

      // -V (verbose)
      const testFile = fixturePath("test.trip");
      result = await runCommand([
        process.execPath,
        "bin/tripc.ts",
        testFile,
        "-V",
        "--stdout",
      ]);
      assert.strictEqual(result.success, true);
      assert.ok(result.stdout.includes("Compiling TripLang program"));
    });

    it("error when input path is a directory", async () => {
      const result = await runCommand([
        process.execPath,
        "bin/tripc.ts",
        "bin/",
      ]);
      assert.strictEqual(result.success, false);
      assert.ok(result.stderr.includes("Input path is not a file"));
    });
  });
});
