/**
 * CLI Integration Tests
 *
 * Tests for CLI integration with the library:
 * - CLI uses library functions correctly
 * - Object file format validation
 * - Error handling consistency
 * - Cross-format compatibility
 */

import {
  strictEqual as equal,
  deepStrictEqual as deepEqual,
  ok,
  match,
} from "node:assert/strict";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { readFile, rm, mkdtemp } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import process from "node:process";
import { requiredAt } from "../util/required.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "../..");
const fixturesDir = join(__dirname, "fixtures");

// Import library functions for testing
import {
  compileToObjectFile,
  deserializeTripCObject,
} from "../../lib/compiler/index.ts";

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
  const executable = requiredAt(command, 0, "expected command executable");
  const args = command.slice(1);

  const result = spawnSync(executable, args, {
    cwd,
    encoding: "utf-8",
  });

  return {
    success: result.status === 0,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    code: result.status,
  };
}

function fixturePath(fixtureName: string): string {
  return join(fixturesDir, fixtureName);
}

test("CLI Integration Tests", async (t) => {
  const testCases = [
    {
      name: "simple module",
      fixture: "simple.trip",
    },
    {
      name: "module with imports",
      fixture: "with_imports.trip",
    },
    {
      name: "module with types",
      fixture: "with_types.trip",
    },
    {
      name: "module with combinators",
      fixture: "with_combinators.trip",
    },
  ];

  await t.test("Library vs CLI consistency", async (t) => {
    for (const testCase of testCases) {
      await t.test(
        `library and CLI produce same output for ${testCase.name}`,
        async () => {
          const testFile = fixturePath(testCase.fixture);

          // Compile using library
          const sourceContent = await readFile(testFile, "utf-8");
          const libraryResult = compileToObjectFile(sourceContent);

          // Compile using CLI
          const cliResult = await runCommand([
            process.execPath,
            "--experimental-transform-types",
            "bin/tripc.ts",
            testFile,
            "--stdout",
          ]);

          ok(cliResult.success, `CLI failed: ${cliResult.stderr}`);

          // Read CLI output
          const cliResultParsed = deserializeTripCObject(cliResult.stdout);

          // Compare results
          equal(cliResultParsed.module, libraryResult.module);
          deepEqual(cliResultParsed.imports, libraryResult.imports);
          deepEqual(cliResultParsed.exports, libraryResult.exports);
          deepEqual(
            cliResultParsed.dataDefinitions,
            libraryResult.dataDefinitions,
          );
          deepEqual(
            Object.keys(cliResultParsed.definitions),
            Object.keys(libraryResult.definitions),
          );
        },
      );
    }
  });

  await t.test("Object file format validation", async (t) => {
    await t.test("CLI produces valid object files", async () => {
      const testFile = fixturePath(
        requiredAt(testCases, 0, "expected first test case").fixture,
      );

      const result = await runCommand([
        process.execPath,
        "--experimental-transform-types",
        "bin/tripc.ts",
        testFile,
        "--stdout",
      ]);

      ok(result.success);

      const objectContent = result.stdout;

      // Should be valid JSON
      const parsed = JSON.parse(objectContent);

      // Should have required fields
      ok("module" in parsed);
      ok("imports" in parsed);
      ok("exports" in parsed);
      ok("definitions" in parsed);
      ok("dataDefinitions" in parsed);

      // Should be deserializable
      const deserialized = deserializeTripCObject(objectContent);
      deepEqual(deserialized, parsed);
    });

    await t.test("object file contains elaborated definitions", async () => {
      const testFile = fixturePath("test.trip");

      const result = await runCommand([
        process.execPath,
        "--experimental-transform-types",
        "bin/tripc.ts",
        testFile,
        "--stdout",
      ]);

      ok(result.success);

      const objectContent = result.stdout;
      const parsed = JSON.parse(objectContent);

      // Check that definition is elaborated (not just parsed)
      const idDef = parsed.definitions.id;
      ok("kind" in idDef && idDef.kind === "poly");
      ok("name" in idDef && idDef.name === "id");
      ok("term" in idDef);

      // Term should be elaborated System F
      ok("kind" in idDef.term && idDef.term.kind === "systemF-type-abs");
    });
  });

  await t.test("Error handling consistency", async (t) => {
    await t.test("library and CLI handle errors consistently", async () => {
      const testFile = fixturePath("invalid_expression.trip");

      const sourceContent = await readFile(testFile, "utf-8");
      // Library should parse invalid syntax as non-terminal (current behavior)
      const libraryResult = compileToObjectFile(sourceContent);
      equal(libraryResult.module, "Test");
      ok("id" in libraryResult.definitions);

      // CLI should also succeed (current behavior)
      const cliResult = await runCommand([
        process.execPath,
        "--experimental-transform-types",
        "bin/tripc.ts",
        testFile,
        "--stdout",
      ]);

      ok(cliResult.success);
    });

    await t.test("missing module definition", async () => {
      const testFile = fixturePath("no_module.trip");

      const result = await runCommand([
        process.execPath,
        "--experimental-transform-types",
        "bin/tripc.ts",
        testFile,
      ]);

      ok(!result.success);
      match(result.stderr, /No module definition found/);
    });

    await t.test("multiple module definitions", async () => {
      const testFile = fixturePath("multiple_modules.trip");

      const result = await runCommand([
        process.execPath,
        "--experimental-transform-types",
        "bin/tripc.ts",
        testFile,
      ]);

      ok(!result.success);
      match(result.stderr, /Multiple module definitions found/);
    });
  });

  await t.test("Cross-format compatibility", async (t) => {
    await t.test("different CLI formats produce identical output", async () => {
      const testFile = fixturePath(
        requiredAt(testCases, 0, "expected first test case").fixture,
      );

      // Test TypeScript CLI with stdout
      const tsResult = await runCommand([
        process.execPath,
        "--experimental-transform-types",
        "bin/tripc.ts",
        testFile,
        "--stdout",
      ]);
      ok(tsResult.success);

      // Test with implicit output (using temp path for this one since we want to compare file output)
      const tempDir = await mkdtemp(join(tmpdir(), "typed-ski-compat-"));
      const output1Path = join(tempDir, "output1.tripc");

      try {
        const fileResult = await runCommand([
          process.execPath,
          "--experimental-transform-types",
          "bin/tripc.ts",
          testFile,
          output1Path,
        ]);
        ok(fileResult.success);

        // Compare outputs
        const fileOutput = await readFile(output1Path, "utf-8");
        equal(tsResult.stdout.trim(), fileOutput.trim());
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    });
  });

  await t.test("Performance and resource usage", async (t) => {
    await t.test("CLI handles large files efficiently", async () => {
      const testFile = fixturePath("large.trip");

      const result = await runCommand([
        process.execPath,
        "--experimental-transform-types",
        "bin/tripc.ts",
        testFile,
        "--stdout",
      ]);

      ok(result.success);

      // Verify output
      const objectContent = result.stdout;
      const parsed = JSON.parse(objectContent);

      equal(parsed.exports.length, 100);
      equal(Object.keys(parsed.definitions).length, 100);
    });
  });
});
