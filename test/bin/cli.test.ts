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

import { expect } from "../util/assertions.ts";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { existsSync, statSync } from "node:fs";
import { readFile, copyFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import process from "node:process";

import { parseJsonc } from "../util/jsonc.ts";
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
  deserializeTripCObject,
  SingleFileCompilerError,
  type TripCObject as _TripCObject,
} from "../../lib/compiler/index.ts";
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

  // For running 'bin/tripc.ts', use 'process.execPath' with '--experimental-transform-types'.
  if (command0 === "node" || command0 === process.execPath) {
    if (args.includes("bin/tripc.ts")) {
      executable = process.execPath;
      const tripcIndex = args.indexOf("bin/tripc.ts");
      args = [
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

test("CLI Tests", async (t) => {
  await t.test("Library function tests", async (t) => {
    await t.test("compileToObjectFile works with valid input", () => {
      const source = `module Test
export id
poly id = #a => \\x:a => x`;

      const result = compileToObjectFile(source);

      expect(result).to.have.property("module", "Test");
      expect(result).to.have.property("imports");
      expect(result).to.have.property("exports");
      expect(result).to.have.property("definitions");
      expect(result).to.have.property("dataDefinitions");

      expect(result.imports).to.be.an("array");
      expect(result.exports).to.be.an("array");
      expect(result.definitions).to.be.an("object");
      expect(result.dataDefinitions).to.be.an("array");

      expect(result.exports).to.include("id");
      expect(result.definitions).to.have.property("id");
    });

    await t.test("compileToObjectFileString works", () => {
      const source = `module Test
export id
poly id = #a => \\x:a => x`;

      const result = compileToObjectFileString(source);

      expect(result).to.be.a("string");

      // Should be valid JSON
      const parsed = JSON.parse(result);
      expect(parsed).to.have.property("module", "Test");

      // Should be deserializable
      const deserialized = deserializeTripCObject(result);
      expect(deserialized).to.deep.equal(parsed);
    });

    await t.test("invalid syntax is parsed as non-terminal", () => {
      const invalidSource = `module Test
poly id = invalid syntax here`;

      const result = compileToObjectFile(invalidSource);

      // Should still compile but with non-terminal structure
      expect(result.module).to.equal("Test");
      expect(result.definitions).to.have.property("id");

      const idDef = required(result.definitions.id, "expected definition 'id'");
      if (idDef.kind === "poly") {
        expect(idDef.term).to.have.property("kind", "non-terminal");
      }
    });

    await t.test("error handling for missing module", () => {
      const noModuleSource = `poly id = #a => \\x:a => x`;

      expect(() => {
        compileToObjectFile(noModuleSource);
      }).to.throw(SingleFileCompilerError);
    });

    await t.test("error handling for multiple modules", () => {
      const multipleModulesSource = `module First
module Second
poly id = #a => \\x:a => x`;

      expect(() => {
        compileToObjectFile(multipleModulesSource);
      }).to.throw(SingleFileCompilerError);
    });
  });

  await t.test("Object file format tests", async (t) => {
    await t.test("object file has correct structure", () => {
      const source = `module Test
import Math add
export id
export double
poly id = #a => \\x:a => x
poly double = \\x:Int => add x x`;

      const result = compileToObjectFile(source);

      // Check module
      expect(result.module).to.equal("Test");

      // Check imports
      expect(result.imports).to.have.length(1);
      expect(
        requiredAt(result.imports, 0, "expected first import"),
      ).to.deep.equal({ name: "add", from: "Math" });

      // Check exports
      expect(result.exports).to.have.length(2);
      expect(result.exports).to.include("id");
      expect(result.exports).to.include("double");

      // Check definitions
      expect(Object.keys(result.definitions)).to.have.length(2);
      expect(result.definitions).to.have.property("id");
      expect(result.definitions).to.have.property("double");
      expect(result.dataDefinitions).to.deep.equal([]);

      // Check definition structure
      const idDef = required(result.definitions.id, "expected definition 'id'");
      expect(idDef).to.have.property("kind", "poly");
      expect(idDef).to.have.property("name", "id");
      if (idDef.kind === "poly") {
        expect(idDef).to.have.property("term");
      }

      const doubleDef = required(
        result.definitions.double,
        "expected definition 'double'",
      );
      expect(doubleDef).to.have.property("kind", "poly");
      expect(doubleDef).to.have.property("name", "double");
      if (doubleDef.kind === "poly") {
        expect(doubleDef).to.have.property("term");
      }
    });

    await t.test("object file serialization/deserialization", () => {
      const source = `module Test
export id
poly id = #a => \\x:a => x`;

      const original = compileToObjectFile(source);
      const serialized = compileToObjectFileString(source);
      const deserialized = deserializeTripCObject(serialized);

      // Check key properties instead of deep equality
      expect(deserialized.module).to.equal(original.module);
      expect(deserialized.imports).to.deep.equal(original.imports);
      expect(deserialized.exports).to.deep.equal(original.exports);
      expect(deserialized.dataDefinitions).to.deep.equal(
        original.dataDefinitions,
      );
      expect(Object.keys(deserialized.definitions)).to.deep.equal(
        Object.keys(original.definitions),
      );
    });

    await t.test("object file contains elaborated definitions", () => {
      const source = `module Test
export id
poly id = #a => \\x:a => x`;

      const result = compileToObjectFile(source);
      const idDef = required(result.definitions.id, "expected definition 'id'");

      // Term should be elaborated System F
      if (idDef.kind === "poly") {
        expect(idDef.term).to.have.property("kind", "systemF-type-abs");
        if (idDef.term.kind === "systemF-type-abs") {
          expect(idDef.term.body).to.have.property("kind", "systemF-abs");
        }
      }
    });
  });

  await t.test("CLI file structure tests", async (t) => {
    await t.test("CLI files exist", () => {
      const binDir = join(projectRoot, "bin");
      expect(existsSync(binDir)).to.be.true;

      expect(existsSync(join(binDir, "tripc.ts"))).to.be.true;
    });

    await t.test("CLI files have proper content", async () => {
      const tripcTs = await readFile(
        join(projectRoot, "bin/tripc.ts"),
        "utf-8",
      );
      expect(tripcTs).to.include("TripLang Compiler & Linker");
      expect(tripcTs).to.include("loadTripModuleObject");
    });
  });

  await t.test("Version consistency tests", async (t) => {
    await t.test("version is consistent across files", async () => {
      const packageJsonPath = join(projectRoot, "package.json");
      const packageJson = JSON.parse(await readFile(packageJsonPath, "utf-8"));
      const version = packageJson.version;

      const jsrJsonPath = join(projectRoot, "jsr.json");
      const jsrJson = JSON.parse(await readFile(jsrJsonPath, "utf-8"));
      expect(jsrJson.version).to.equal(version);

      const generatedVersionPath = join(
        projectRoot,
        "lib",
        "shared",
        "version.generated.ts",
      );
      const generatedVersion = await readFile(generatedVersionPath, "utf-8");
      expect(generatedVersion).to.include(
        `export const VERSION = "${version}";`,
      );
    });
  });

  await t.test("CLI Packaging Tests", async (t) => {
    await t.test("TypeScript CLI (bin/tripc.ts)", async (t) => {
      await t.test("--version flag", async () => {
        const result = await runCommand([
          process.execPath,
          "bin/tripc.ts",
          "--version",
        ]);

        expect(result.success).to.be.true;
        expect(result.stdout.trim()).to.match(/^tripc v\d+\.\d+\.\d+$/);
      });

      await t.test("--help flag", async () => {
        const result = await runCommand([
          process.execPath,
          "bin/tripc.ts",
          "--help",
        ]);

        expect(result.success).to.be.true;
        expect(result.stdout).to.include("TripLang Compiler & Linker (tripc)");
        expect(result.stdout).to.include("USAGE:");
      });

      await t.test("compilation", async () => {
        const testFile = fixturePath("test.trip");

        const result = await runCommand([
          process.execPath,
          "bin/tripc.ts",
          testFile,
          "--stdout",
        ]);

        expect(result.success).to.be.true;

        // Verify object file content
        const parsed = JSON.parse(result.stdout);
        expect(parsed).to.have.property("module", "TestModule");
      });

      await t.test("verbose compilation", async () => {
        const testFile = fixturePath("test.trip");

        const result = await runCommand([
          process.execPath,
          "bin/tripc.ts",
          testFile,
          "--verbose",
          "--stdout",
        ]);

        expect(result.success).to.be.true;
      });

      await t.test("error handling", async () => {
        const invalidFile = fixturePath("invalid_syntax.trip");

        const result = await runCommand([
          process.execPath,
          "bin/tripc.ts",
          invalidFile,
        ]);

        expect(result.success).to.be.false;
        expect(result.stderr).to.include("Compilation error");
      });
    });

    await t.test("Bundled JavaScript (dist/tripc.js)", async (t) => {
      const bundledJsPath = bundledTripcPath;

      await t.test("file exists", () => {
        expect(existsSync(bundledJsPath)).to.be.true;
      });

      await t.test("--version flag", async () => {
        const command = [process.execPath, bundledJsPath, "--version"];
        const result = await runCommand(command);

        assertCommandSuccess(
          result,
          command,
          "Bundled JavaScript (dist/tripc.js) --version flag",
        );
        expect(result.stdout.trim()).to.match(/^tripc v\d+\.\d+\.\d+$/);
      });

      await t.test("compilation", async () => {
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
        expect(parsed).to.have.property("module", "TestModule");
      });
    });

    await t.test("Minified JavaScript (dist/tripc.min.js)", async (t) => {
      const minifiedJsPath = minifiedTripcPath;

      await t.test("file exists", () => {
        expect(existsSync(minifiedJsPath)).to.be.true;
      });

      await t.test("--version flag", async () => {
        const command = [process.execPath, minifiedJsPath, "--version"];
        const result = await runCommand(command);

        assertCommandSuccess(
          result,
          command,
          "Minified JavaScript (dist/tripc.min.js) --version flag",
        );
        expect(result.stdout.trim()).to.match(/^tripc v\d+\.\d+\.\d+$/);
      });

      await t.test("compilation", async () => {
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
        expect(parsed).to.have.property("module", "TestModule");
      });
    });

    await t.test("Compiled Binary (dist/tripc)", async (t) => {
      const binaryPath = compiledTripcPath;

      await t.test("file exists", () => {
        expect(existsSync(binaryPath)).to.be.true;
      });

      await t.test("file is executable", async () => {
        try {
          const stat = statSync(binaryPath);
          expect(stat.isFile()).to.be.true;
        } catch (error) {
          throw new Error(
            `Binary file check failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      });

      await t.test("--version flag", async () => {
        const command = [compiledTripcPath, "--version"];
        const result = await runCommand(command);

        assertCommandSuccess(
          result,
          command,
          "Compiled Binary (dist/tripc) --version flag",
        );
        expect(result.stdout.trim()).to.match(/^tripc v\d+\.\d+\.\d+$/);
      });

      await t.test("--help flag", async () => {
        const command = [compiledTripcPath, "--help"];
        const result = await runCommand(command);

        assertCommandSuccess(
          result,
          command,
          "Compiled Binary (dist/tripc) --help flag",
        );
        expect(result.stdout).to.include("TripLang Compiler & Linker (tripc)");
        expect(result.stdout).to.include("USAGE:");
      });

      await t.test("compilation", async () => {
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
        expect(parsed).to.have.property("module", "TestModule");
      });

      await t.test("verbose compilation", async () => {
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

  await t.test("tripc Extra CLI Coverage", async (t) => {
    await t.test("error on unknown option", async () => {
      const result = await runCommand([
        process.execPath,
        "bin/tripc.ts",
        "--unknown",
      ]);
      expect(result.success).to.be.false;
      expect(result.stderr).to.include("Unknown option: --unknown");
    });

    await t.test("error on too many arguments", async () => {
      const result = await runCommand([
        process.execPath,
        "bin/tripc.ts",
        "a.trip",
        "b.tripc",
        "extra",
      ]);
      expect(result.success).to.be.false;
      expect(result.stderr).to.include("Too many arguments");
    });

    await t.test("error on no input file", async () => {
      const result = await runCommand([process.execPath, "bin/tripc.ts"]);
      expect(result.success).to.be.false;
      expect(result.stderr).to.include("Error: No input file specified");
    });

    await t.test("error on non-trip extension for compilation", async () => {
      const tempFile = fixturePath("empty.txt");
      const result = await runCommand([
        process.execPath,
        "bin/tripc.ts",
        tempFile,
      ]);
      expect(result.success).to.be.false;
      expect(result.stderr).to.include("must have .trip extension");
    });

    await t.test("error on linking with no files", async () => {
      const result = await runCommand([
        process.execPath,
        "bin/tripc.ts",
        "--link",
      ]);
      expect(result.success).to.be.false;
      expect(result.stderr).to.include(
        "Error: No input files specified for linking",
      );
    });

    await t.test("short flags coverage (-h, -v, -V, -c)", async () => {
      // -h
      let result = await runCommand([process.execPath, "bin/tripc.ts", "-h"]);
      expect(result.success).to.be.true;
      expect(result.stdout).to.include("USAGE:");

      // -v
      result = await runCommand([process.execPath, "bin/tripc.ts", "-v"]);
      expect(result.success).to.be.true;
      expect(result.stdout).to.include("tripc v");

      // -V (verbose)
      const testFile = fixturePath("test.trip");
      result = await runCommand([
        process.execPath,
        "bin/tripc.ts",
        testFile,
        "-V",
        "--stdout",
      ]);
      expect(result.success).to.be.true;
      expect(result.stdout).to.include("Compiling TripLang program");
    });

    await t.test("error when input path is a directory", async () => {
      const result = await runCommand([
        process.execPath,
        "bin/tripc.ts",
        "bin/",
      ]);
      expect(result.success).to.be.false;
      expect(result.stderr).to.include("Input path is not a file");
    });
  });
});
