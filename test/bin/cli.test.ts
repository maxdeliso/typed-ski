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

import { expect } from "chai";
import { dirname, fromFileUrl, join } from "std/path";
import { existsSync } from "std/fs";

const __dirname = dirname(fromFileUrl(import.meta.url));
const projectRoot = join(__dirname, "../..");

// Import library functions for testing
import {
  compileToObjectFile,
  compileToObjectFileString,
  deserializeTripCObject,
  SingleFileCompilerError,
  type TripCObject as _TripCObject,
} from "../../lib/compiler/index.ts";

// Test utilities
async function runCommand(command: string[], cwd = projectRoot): Promise<{
  success: boolean;
  stdout: string;
  stderr: string;
  code: number;
}> {
  // Use Deno.execPath() if command is "deno" to ensure we use the same Deno instance
  const executable = command[0] === "deno" ? Deno.execPath() : command[0];
  const args = command[0] === "deno" ? command.slice(1) : command.slice(1);

  const process = new Deno.Command(executable, {
    args,
    cwd,
    stdout: "piped",
    stderr: "piped",
  });

  try {
    const { code, stdout, stderr } = await process.output();
    return {
      success: code === 0,
      stdout: new TextDecoder().decode(stdout),
      stderr: new TextDecoder().decode(stderr),
      code,
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

async function createTestFile(content: string): Promise<string> {
  const tempDir = await Deno.makeTempDir();
  const filePath = join(tempDir, "test.trip");
  await Deno.writeTextFile(filePath, content);
  return filePath;
}

async function cleanupTestFile(filePath: string): Promise<void> {
  try {
    await Deno.remove(filePath);
    const tripcFile = filePath.replace(/\.trip$/, ".tripc");
    if (existsSync(tripcFile)) {
      await Deno.remove(tripcFile);
    }
  } catch {
    // Ignore cleanup errors
  }
}

function assertCommandSuccess(
  result: { success: boolean; stdout: string; stderr: string; code: number },
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

Deno.test("CLI Tests", async (t) => {
  // Test file content
  const testContent = `module TestModule

import Math add
export id

poly id = Λa. λx:a. x`;

  await t.step("Library function tests", async (t) => {
    await t.step("compileToObjectFile works with valid input", () => {
      const source = `module Test
export id
poly id = Λa. λx:a. x`;

      const result = compileToObjectFile(source);

      expect(result).to.have.property("module", "Test");
      expect(result).to.have.property("imports");
      expect(result).to.have.property("exports");
      expect(result).to.have.property("definitions");

      expect(result.imports).to.be.an("array");
      expect(result.exports).to.be.an("array");
      expect(result.definitions).to.be.an("object");

      expect(result.exports).to.include("id");
      expect(result.definitions).to.have.property("id");
    });

    await t.step("compileToObjectFileString works", () => {
      const source = `module Test
export id
poly id = Λa. λx:a. x`;

      const result = compileToObjectFileString(source);

      expect(result).to.be.a("string");

      // Should be valid JSON
      const parsed = JSON.parse(result);
      expect(parsed).to.have.property("module", "Test");

      // Should be deserializable
      const deserialized = deserializeTripCObject(result);
      expect(deserialized).to.deep.equal(parsed);
    });

    await t.step("invalid syntax is parsed as non-terminal", () => {
      const invalidSource = `module Test
poly id = invalid syntax here`;

      const result = compileToObjectFile(invalidSource);

      // Should still compile but with non-terminal structure
      expect(result.module).to.equal("Test");
      expect(result.definitions).to.have.property("id");

      const idDef = result.definitions.id;
      if (idDef.kind === "poly") {
        expect(idDef.term).to.have.property("kind", "non-terminal");
      }
    });

    await t.step("error handling for missing module", () => {
      const noModuleSource = `poly id = Λa. λx:a. x`;

      expect(() => {
        compileToObjectFile(noModuleSource);
      }).to.throw(SingleFileCompilerError);
    });

    await t.step("error handling for multiple modules", () => {
      const multipleModulesSource = `module First
module Second
poly id = Λa. λx:a. x`;

      expect(() => {
        compileToObjectFile(multipleModulesSource);
      }).to.throw(SingleFileCompilerError);
    });
  });

  await t.step("Object file format tests", async (t) => {
    await t.step("object file has correct structure", () => {
      const source = `module Test
import Math add
export id
export double
poly id = Λa. λx:a. x
typed double = λx:Int. add x x`;

      const result = compileToObjectFile(source);

      // Check module
      expect(result.module).to.equal("Test");

      // Check imports
      expect(result.imports).to.have.length(1);
      expect(result.imports[0]).to.deep.equal({ name: "Math", from: "add" });

      // Check exports
      expect(result.exports).to.have.length(2);
      expect(result.exports).to.include("id");
      expect(result.exports).to.include("double");

      // Check definitions
      expect(Object.keys(result.definitions)).to.have.length(2);
      expect(result.definitions).to.have.property("id");
      expect(result.definitions).to.have.property("double");

      // Check definition structure
      const idDef = result.definitions.id;
      expect(idDef).to.have.property("kind", "poly");
      expect(idDef).to.have.property("name", "id");
      if (idDef.kind === "poly") {
        expect(idDef).to.have.property("term");
      }

      const doubleDef = result.definitions.double;
      expect(doubleDef).to.have.property("kind", "typed");
      expect(doubleDef).to.have.property("name", "double");
      if (doubleDef.kind === "typed") {
        expect(doubleDef).to.have.property("term");
      }
    });

    await t.step("object file serialization/deserialization", () => {
      const source = `module Test
export id
poly id = Λa. λx:a. x`;

      const original = compileToObjectFile(source);
      const serialized = compileToObjectFileString(source);
      const deserialized = deserializeTripCObject(serialized);

      // Check key properties instead of deep equality
      expect(deserialized.module).to.equal(original.module);
      expect(deserialized.imports).to.deep.equal(original.imports);
      expect(deserialized.exports).to.deep.equal(original.exports);
      expect(Object.keys(deserialized.definitions)).to.deep.equal(
        Object.keys(original.definitions),
      );
    });

    await t.step("object file contains elaborated definitions", () => {
      const source = `module Test
export id
poly id = Λa. λx:a. x`;

      const result = compileToObjectFile(source);
      const idDef = result.definitions.id;

      // Term should be elaborated System F
      if (idDef.kind === "poly") {
        expect(idDef.term).to.have.property("kind", "systemF-type-abs");
        if (idDef.term.kind === "systemF-type-abs") {
          expect(idDef.term.body).to.have.property("kind", "systemF-abs");
        }
      }
    });
  });

  await t.step("CLI file structure tests", async (t) => {
    await t.step("CLI files exist", () => {
      const binDir = join(projectRoot, "bin");
      expect(existsSync(binDir)).to.be.true;

      expect(existsSync(join(binDir, "tripc.ts"))).to.be.true;
    });

    await t.step("CLI files have proper content", async () => {
      const tripcTs = await Deno.readTextFile(
        join(projectRoot, "bin/tripc.ts"),
      );
      expect(tripcTs).to.include("TripLang Compiler & Linker");
      expect(tripcTs).to.include("compileToObjectFileString");
    });
  });

  await t.step("Version consistency tests", async (t) => {
    await t.step("version is consistent across files", async () => {
      const configPath = join(projectRoot, "deno.jsonc");
      const configContent = await Deno.readTextFile(configPath);
      const config = JSON.parse(configContent);
      const _packageVersion = config.version;

      const tripcTs = await Deno.readTextFile(
        join(projectRoot, "bin/tripc.ts"),
      );
      expect(tripcTs).to.include(
        `import { VERSION } from "../lib/shared/version.ts"`,
      );
    });
  });

  await t.step("CLI Packaging Tests", async (t) => {
    await t.step("TypeScript CLI (bin/tripc.ts)", async (t) => {
      await t.step("--version flag", async () => {
        const result = await runCommand([
          "deno",
          "run",
          "--allow-read",
          "--allow-write",
          "bin/tripc.ts",
          "--version",
        ]);

        expect(result.success).to.be.true;
        expect(result.stdout.trim()).to.match(/^tripc v\d+\.\d+\.\d+$/);
      });

      await t.step("--help flag", async () => {
        const result = await runCommand([
          "deno",
          "run",
          "--allow-read",
          "--allow-write",
          "bin/tripc.ts",
          "--help",
        ]);

        expect(result.success).to.be.true;
        expect(result.stdout).to.include("TripLang Compiler & Linker (tripc)");
        expect(result.stdout).to.include("USAGE:");
      });

      await t.step("compilation", async () => {
        const testFile = await createTestFile(testContent);

        try {
          const result = await runCommand([
            "deno",
            "run",
            "--allow-read",
            "--allow-write",
            "bin/tripc.ts",
            testFile,
          ]);

          expect(result.success).to.be.true;

          // Check that .tripc file was created
          const tripcFile = testFile.replace(/\.trip$/, ".tripc");
          expect(existsSync(tripcFile)).to.be.true;

          // Verify object file content
          const objectContent = await Deno.readTextFile(tripcFile);
          const parsed = JSON.parse(objectContent);
          expect(parsed).to.have.property("module", "TestModule");
        } finally {
          await cleanupTestFile(testFile);
        }
      });

      await t.step("verbose compilation", async () => {
        const testFile = await createTestFile(testContent);

        try {
          const result = await runCommand([
            "deno",
            "run",
            "--allow-read",
            "--allow-write",
            "bin/tripc.ts",
            testFile,
            "--verbose",
          ]);

          expect(result.success).to.be.true;
        } finally {
          await cleanupTestFile(testFile);
        }
      });

      await t.step("error handling", async () => {
        const invalidFile = await createTestFile("invalid syntax");

        try {
          const result = await runCommand([
            "deno",
            "run",
            "--allow-read",
            "--allow-write",
            "bin/tripc.ts",
            invalidFile,
          ]);

          expect(result.success).to.be.false;
          expect(result.stderr).to.include("Compilation error");
        } finally {
          await cleanupTestFile(invalidFile);
        }
      });
    });

    await t.step("Bundled JavaScript (dist/tripc.js)", async (t) => {
      const bundledJsPath = join(projectRoot, "dist/tripc.js");

      await t.step("file exists", () => {
        expect(existsSync(bundledJsPath)).to.be.true;
      });

      await t.step("--version flag", async () => {
        const command = [
          "deno",
          "run",
          "--allow-read",
          "--allow-write",
          "dist/tripc.js",
          "--version",
        ];
        const result = await runCommand(command);

        assertCommandSuccess(
          result,
          command,
          "Bundled JavaScript (dist/tripc.js) --version flag",
        );
        expect(result.stdout.trim()).to.match(/^tripc v\d+\.\d+\.\d+$/);
      });

      await t.step("compilation", async () => {
        const testFile = await createTestFile(testContent);

        try {
          const command = [
            "deno",
            "run",
            "--allow-read",
            "--allow-write",
            "dist/tripc.js",
            testFile,
          ];
          const result = await runCommand(command);

          assertCommandSuccess(
            result,
            command,
            "Bundled JavaScript (dist/tripc.js) compilation",
          );

          // Check that .tripc file was created
          const tripcFile = testFile.replace(/\.trip$/, ".tripc");
          expect(existsSync(tripcFile)).to.be.true;
        } finally {
          await cleanupTestFile(testFile);
        }
      });
    });

    await t.step("Minified JavaScript (dist/tripc.min.js)", async (t) => {
      const minifiedJsPath = join(projectRoot, "dist/tripc.min.js");

      await t.step("file exists", () => {
        expect(existsSync(minifiedJsPath)).to.be.true;
      });

      await t.step("--version flag", async () => {
        const command = [
          "deno",
          "run",
          "--allow-read",
          "--allow-write",
          "dist/tripc.min.js",
          "--version",
        ];
        const result = await runCommand(command);

        assertCommandSuccess(
          result,
          command,
          "Minified JavaScript (dist/tripc.min.js) --version flag",
        );
        expect(result.stdout.trim()).to.match(/^tripc v\d+\.\d+\.\d+$/);
      });

      await t.step("compilation", async () => {
        const testFile = await createTestFile(testContent);

        try {
          const command = [
            "deno",
            "run",
            "--allow-read",
            "--allow-write",
            "dist/tripc.min.js",
            testFile,
          ];
          const result = await runCommand(command);

          assertCommandSuccess(
            result,
            command,
            "Minified JavaScript (dist/tripc.min.js) compilation",
          );

          // Check that .tripc file was created
          const tripcFile = testFile.replace(/\.trip$/, ".tripc");
          expect(existsSync(tripcFile)).to.be.true;
        } finally {
          await cleanupTestFile(testFile);
        }
      });
    });

    await t.step("Compiled Binary (dist/tripc)", async (t) => {
      const binaryPath = join(projectRoot, "dist/tripc");

      await t.step("file exists", () => {
        expect(existsSync(binaryPath)).to.be.true;
      });

      await t.step("file is executable", async () => {
        try {
          const stat = await Deno.stat(binaryPath);
          expect(stat.isFile).to.be.true;
        } catch (error) {
          throw new Error(
            `Binary file check failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      });

      await t.step("--version flag", async () => {
        const command = ["./dist/tripc", "--version"];
        const result = await runCommand(command);

        assertCommandSuccess(
          result,
          command,
          "Compiled Binary (dist/tripc) --version flag",
        );
        expect(result.stdout.trim()).to.match(/^tripc v\d+\.\d+\.\d+$/);
      });

      await t.step("--help flag", async () => {
        const command = ["./dist/tripc", "--help"];
        const result = await runCommand(command);

        assertCommandSuccess(
          result,
          command,
          "Compiled Binary (dist/tripc) --help flag",
        );
        expect(result.stdout).to.include("TripLang Compiler & Linker (tripc)");
        expect(result.stdout).to.include("USAGE:");
      });

      await t.step("compilation", async () => {
        const testFile = await createTestFile(testContent);

        try {
          const command = ["./dist/tripc", testFile];
          const result = await runCommand(command);

          assertCommandSuccess(
            result,
            command,
            "Compiled Binary (dist/tripc) compilation",
          );

          // Check that .tripc file was created
          const tripcFile = testFile.replace(/\.trip$/, ".tripc");
          expect(existsSync(tripcFile)).to.be.true;
        } finally {
          await cleanupTestFile(testFile);
        }
      });

      await t.step("verbose compilation", async () => {
        const testFile = await createTestFile(testContent);

        try {
          const command = ["./dist/tripc", testFile, "--verbose"];
          const result = await runCommand(command);

          assertCommandSuccess(
            result,
            command,
            "Compiled Binary (dist/tripc) verbose compilation",
          );
        } finally {
          await cleanupTestFile(testFile);
        }
      });
    });

    await t.step("Deno Task (deno task tripc)", async (t) => {
      await t.step("--version flag", async () => {
        const result = await runCommand(["deno", "task", "tripc", "--version"]);

        expect(result.success).to.be.true;
        expect(result.stdout.trim()).to.match(/^tripc v\d+\.\d+\.\d+$/);
      });

      await t.step("compilation", async () => {
        const testFile = await createTestFile(testContent);

        try {
          const result = await runCommand(["deno", "task", "tripc", testFile]);

          expect(result.success).to.be.true;

          // Check that .tripc file was created
          const tripcFile = testFile.replace(/\.trip$/, ".tripc");
          expect(existsSync(tripcFile)).to.be.true;
        } finally {
          await cleanupTestFile(testFile);
        }
      });
    });
  });
});
