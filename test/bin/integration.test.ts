/**
 * CLI Integration Tests
 *
 * Tests for CLI integration with the library:
 * - CLI uses library functions correctly
 * - Object file format validation
 * - Error handling consistency
 * - Cross-format compatibility
 */

import { expect } from "chai";
import { dirname, fromFileUrl, join } from "std/path";
import { existsSync } from "std/fs";

const __dirname = dirname(fromFileUrl(import.meta.url));
const projectRoot = join(__dirname, "../..");

// Import library functions for testing
import {
  compileToObjectFile,
  type compileToObjectFileString as _compileToObjectFileString,
  deserializeTripCObject,
  type TripCObject as _TripCObject,
} from "../../lib/compiler/index.ts";

// Test utilities
async function runCommand(command: string[], cwd = projectRoot): Promise<{
  success: boolean;
  stdout: string;
  stderr: string;
  code: number;
}> {
  const process = new Deno.Command(command[0], {
    args: command.slice(1),
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
  const tempFile = join(projectRoot, `test_integration_${Date.now()}.trip`);
  await Deno.writeTextFile(tempFile, content);
  return tempFile;
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

Deno.test("CLI Integration Tests", async (t) => {
  const testCases = [
    {
      name: "simple module",
      content: `module Simple
export id
poly id = Λa. λx:a. x`,
    },
    {
      name: "module with imports",
      content: `module WithImports
import Math add
import Utils format
export double
typed double = λx:Int. add x x`,
    },
    {
      name: "module with types",
      content: `module WithTypes
export Nat
export zero
type Nat = Int
poly zero = Λa. λs:a→a. λz:a. z`,
    },
    {
      name: "module with combinators",
      content: `module WithCombinators
export K
export S
combinator K = K
combinator S = S`,
    },
  ];

  await t.step("Library vs CLI consistency", async (t) => {
    for (const testCase of testCases) {
      await t.step(
        `library and CLI produce same output for ${testCase.name}`,
        async () => {
          const testFile = await createTestFile(testCase.content);

          try {
            // Compile using library
            const sourceContent = await Deno.readTextFile(testFile);
            const libraryResult = compileToObjectFile(sourceContent);

            // Compile using CLI
            const cliResult = await runCommand([
              "deno",
              "run",
              "--allow-read",
              "--allow-write",
              "bin/tripc.ts",
              testFile,
            ]);

            expect(cliResult.success).to.be.true;

            // Read CLI output
            const tripcFile = testFile.replace(/\.trip$/, ".tripc");
            expect(existsSync(tripcFile)).to.be.true;

            const cliOutput = await Deno.readTextFile(tripcFile);
            const cliResultParsed = deserializeTripCObject(cliOutput);

            // Compare results
            expect(cliResultParsed.module).to.equal(libraryResult.module);
            expect(cliResultParsed.imports).to.deep.equal(
              libraryResult.imports,
            );
            expect(cliResultParsed.exports).to.deep.equal(
              libraryResult.exports,
            );
            expect(Object.keys(cliResultParsed.definitions)).to.deep.equal(
              Object.keys(libraryResult.definitions),
            );
          } finally {
            await cleanupTestFile(testFile);
          }
        },
      );
    }
  });

  await t.step("Object file format validation", async (t) => {
    await t.step("CLI produces valid object files", async () => {
      const testFile = await createTestFile(testCases[0].content);

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

        const tripcFile = testFile.replace(/\.trip$/, ".tripc");
        const objectContent = await Deno.readTextFile(tripcFile);

        // Should be valid JSON
        const parsed = JSON.parse(objectContent);

        // Should have required fields
        expect(parsed).to.have.property("module");
        expect(parsed).to.have.property("imports");
        expect(parsed).to.have.property("exports");
        expect(parsed).to.have.property("definitions");

        // Should be deserializable
        const deserialized = deserializeTripCObject(objectContent);
        expect(deserialized).to.deep.equal(parsed);
      } finally {
        await cleanupTestFile(testFile);
      }
    });

    await t.step("object file contains elaborated definitions", async () => {
      const testFile = await createTestFile(`module Test
export id
poly id = Λa. λx:a. x`);

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

        const tripcFile = testFile.replace(/\.trip$/, ".tripc");
        const objectContent = await Deno.readTextFile(tripcFile);
        const parsed = JSON.parse(objectContent);

        // Check that definition is elaborated (not just parsed)
        const idDef = parsed.definitions.id;
        expect(idDef).to.have.property("kind", "poly");
        expect(idDef).to.have.property("name", "id");
        expect(idDef).to.have.property("term");

        // Term should be elaborated System F
        expect(idDef.term).to.have.property("kind", "systemF-type-abs");
      } finally {
        await cleanupTestFile(testFile);
      }
    });
  });

  await t.step("Error handling consistency", async (t) => {
    await t.step("library and CLI handle errors consistently", async () => {
      const invalidContent = `module Test
poly id = invalid syntax here`;

      const testFile = await createTestFile(invalidContent);

      try {
        // Library should parse invalid syntax as non-terminal (current behavior)
        const libraryResult = compileToObjectFile(invalidContent);
        expect(libraryResult.module).to.equal("Test");
        expect(libraryResult.definitions).to.have.property("id");

        // CLI should also succeed (current behavior)
        const cliResult = await runCommand([
          "deno",
          "run",
          "--allow-read",
          "--allow-write",
          "bin/tripc.ts",
          testFile,
        ]);

        expect(cliResult.success).to.be.true;
      } finally {
        await cleanupTestFile(testFile);
      }
    });

    await t.step("missing module definition", async () => {
      const noModuleContent = `poly id = Λa. λx:a. x`;

      const testFile = await createTestFile(noModuleContent);

      try {
        const result = await runCommand([
          "deno",
          "run",
          "--allow-read",
          "--allow-write",
          "bin/tripc.ts",
          testFile,
        ]);

        expect(result.success).to.be.false;
        expect(result.stderr).to.include("No module definition found");
      } finally {
        await cleanupTestFile(testFile);
      }
    });

    await t.step("multiple module definitions", async () => {
      const multipleModulesContent = `module First
module Second
poly id = Λa. λx:a. x`;

      const testFile = await createTestFile(multipleModulesContent);

      try {
        const result = await runCommand([
          "deno",
          "run",
          "--allow-read",
          "--allow-write",
          "bin/tripc.ts",
          testFile,
        ]);

        expect(result.success).to.be.false;
        expect(result.stderr).to.include("Multiple module definitions found");
      } finally {
        await cleanupTestFile(testFile);
      }
    });
  });

  await t.step("Cross-format compatibility", async (t) => {
    await t.step("different CLI formats produce identical output", async () => {
      const testFile = await createTestFile(testCases[0].content);

      try {
        // Test TypeScript CLI
        const tsResult = await runCommand([
          "deno",
          "run",
          "--allow-read",
          "--allow-write",
          "bin/tripc.ts",
          testFile,
          "output1.tripc",
        ]);
        expect(tsResult.success).to.be.true;

        // Test Deno task
        const taskResult = await runCommand([
          "deno",
          "task",
          "tripc",
          testFile,
          "output2.tripc",
        ]);
        expect(taskResult.success).to.be.true;

        // Compare outputs
        const output1 = await Deno.readTextFile("output1.tripc");
        const output2 = await Deno.readTextFile("output2.tripc");

        expect(output1).to.equal(output2);

        // Cleanup
        await Deno.remove("output1.tripc");
        await Deno.remove("output2.tripc");
      } finally {
        await cleanupTestFile(testFile);
      }
    });
  });

  await t.step("Performance and resource usage", async (t) => {
    await t.step("CLI handles large files efficiently", async () => {
      // Create a larger test file
      let largeContent = `module LargeModule\n`;
      for (let i = 0; i < 100; i++) {
        largeContent += `export func${i}\npoly func${i} = Λa. λx:a. x\n`;
      }

      const testFile = await createTestFile(largeContent);

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

        // Verify output
        const tripcFile = testFile.replace(/\.trip$/, ".tripc");
        const objectContent = await Deno.readTextFile(tripcFile);
        const parsed = JSON.parse(objectContent);

        expect(parsed.exports).to.have.length(100);
        expect(Object.keys(parsed.definitions)).to.have.length(100);
      } finally {
        await cleanupTestFile(testFile);
      }
    });
  });
});
