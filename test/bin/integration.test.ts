/**
 * CLI Integration Tests
 *
 * Tests for CLI integration with the library:
 * - CLI uses library functions correctly
 * - Object file format validation
 * - Error handling consistency
 * - Cross-format compatibility
 */

import { describe, it } from "../util/test_shim.ts";
import { strictEqual as equal } from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

import { compileToObjectFile } from "../../lib/compiler/singleFileCompiler.ts";
import {
  cleanupTempWorkspace,
  createTempWorkspace,
} from "../util/tripcHarness.ts";
import { required, requiredAt } from "../util/required.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "../..");

describe("CLI Integration", () => {
  describe("Library vs CLI consistency", () => {
    it("library and CLI produce same output for simple module", async () => {
      const source = `module Test
export id
poly id = #a => \\x:a => x`;

      const workspaceDir = await createTempWorkspace("cli-integration-");
      try {
        const tripFile = join(workspaceDir, "test.trip");
        const tripcFile = join(workspaceDir, "test.tripc");
        writeFileSync(tripFile, source);

        // Run CLI
        const tripcPath = join(projectRoot, "bin/tripc.ts");
        const cliResult = spawnSync(
          "node",
          [
            "--disable-warning=ExperimentalWarning",
            "--experimental-transform-types",
            tripcPath,
            tripFile,
            tripcFile,
          ],
          { encoding: "utf-8" },
        );
        equal(cliResult.status, 0, cliResult.stderr);

        // Run library
        const libResult = compileToObjectFile(source);

        // Read CLI output
        const cliOutput = JSON.parse(readFileSync(tripcFile, "utf-8")) as any;

        // Compare key fields
        equal(cliOutput.module, libResult.module);
        equal(cliOutput.exports.length, libResult.exports.length);
        equal(
          Object.keys(cliOutput.definitions).length,
          Object.keys(libResult.definitions).length,
        );
      } finally {
        await cleanupTempWorkspace(workspaceDir);
      }
    });

    it("library and CLI produce same output for module with imports", async () => {
      const source = `module Test
import Math add
export double
poly double = \\x:Int => add x x`;

      const workspaceDir = await createTempWorkspace(
        "cli-integration-imports-",
      );
      try {
        const tripFile = join(workspaceDir, "test.trip");
        const tripcFile = join(workspaceDir, "test.tripc");
        writeFileSync(tripFile, source);

        // Run CLI
        const tripcPath = join(projectRoot, "bin/tripc.ts");
        const cliResult = spawnSync(
          "node",
          [
            "--disable-warning=ExperimentalWarning",
            "--experimental-transform-types",
            tripcPath,
            tripFile,
            tripcFile,
          ],
          { encoding: "utf-8" },
        );
        equal(cliResult.status, 0, cliResult.stderr);

        // Run library
        const libResult = compileToObjectFile(source);

        // Read CLI output
        const cliOutput = JSON.parse(readFileSync(tripcFile, "utf-8")) as any;

        // Compare
        equal(cliOutput.module, libResult.module);
        equal(cliOutput.imports.length, libResult.imports.length);
        const cliImport0 = requiredAt(
          cliOutput.imports,
          0,
          "cli import missing",
        ) as any;
        const libImport0 = requiredAt(
          libResult.imports,
          0,
          "lib import missing",
        );
        equal(cliImport0.name, libImport0.name);
        equal(cliImport0.from, libImport0.from);
      } finally {
        await cleanupTempWorkspace(workspaceDir);
      }
    });

    it("library and CLI produce same output for module with types", async () => {
      const source = `module Test
type MyType = Int -> Int
export id
poly id : MyType = \\x:Int => x`;

      const workspaceDir = await createTempWorkspace("cli-integration-types-");
      try {
        const tripFile = join(workspaceDir, "test.trip");
        const tripcFile = join(workspaceDir, "test.tripc");
        writeFileSync(tripFile, source);

        // Run CLI
        const tripcPath = join(projectRoot, "bin/tripc.ts");
        const cliResult = spawnSync(
          "node",
          [
            "--disable-warning=ExperimentalWarning",
            "--experimental-transform-types",
            tripcPath,
            tripFile,
            tripcFile,
          ],
          { encoding: "utf-8" },
        );
        equal(cliResult.status, 0, cliResult.stderr);

        // Run library
        const libResult = compileToObjectFile(source);

        // Read CLI output
        const cliOutput = JSON.parse(readFileSync(tripcFile, "utf-8")) as any;

        // Compare
        equal(cliOutput.module, libResult.module);
        equal(
          Object.keys(cliOutput.definitions).length,
          Object.keys(libResult.definitions).length,
        );
      } finally {
        await cleanupTempWorkspace(workspaceDir);
      }
    });

    it("library and CLI produce same output for module with combinators", async () => {
      const source = `module Test
combinator myI = I
export myI`;

      const workspaceDir = await createTempWorkspace("cli-integration-comb-");
      try {
        const tripFile = join(workspaceDir, "test.trip");
        const tripcFile = join(workspaceDir, "test.tripc");
        writeFileSync(tripFile, source);

        // Run CLI
        const tripcPath = join(projectRoot, "bin/tripc.ts");
        const cliResult = spawnSync(
          "node",
          [
            "--disable-warning=ExperimentalWarning",
            "--experimental-transform-types",
            tripcPath,
            tripFile,
            tripcFile,
          ],
          { encoding: "utf-8" },
        );
        equal(cliResult.status, 0, cliResult.stderr);

        // Run library
        const libResult = compileToObjectFile(source);

        // Read CLI output
        const cliOutput = JSON.parse(readFileSync(tripcFile, "utf-8")) as any;

        // Compare
        equal(cliOutput.module, libResult.module);
        const cliMyI = required(cliOutput.definitions.myI, "cli myI missing");
        const libMyI = required(libResult.definitions.myI, "lib myI missing");
        equal(cliMyI.kind, "combinator");
        equal(libMyI.kind, "combinator");
      } finally {
        await cleanupTempWorkspace(workspaceDir);
      }
    });
  });

  describe("Object file validation", () => {
    it("CLI handles very large module", async () => {
      // Create a module with 100 definitions
      let source = "module Large\n";
      for (let i = 0; i < 100; i++) {
        source += `export f${i}\npoly f${i} = #a => \\x:a => x\n`;
      }

      const workspaceDir = await createTempWorkspace("cli-integration-large-");
      try {
        const tripFile = join(workspaceDir, "large.trip");
        const tripcFile = join(workspaceDir, "large.tripc");
        writeFileSync(tripFile, source);

        const tripcPath = join(projectRoot, "bin/tripc.ts");
        const result = spawnSync(
          "node",
          [
            "--disable-warning=ExperimentalWarning",
            "--experimental-transform-types",
            tripcPath,
            tripFile,
            tripcFile,
          ],
          { encoding: "utf-8" },
        );

        equal(result.status, 0, result.stderr);

        // Verify output
        const objectContent = readFileSync(tripcFile, "utf-8");
        const parsed = JSON.parse(objectContent);

        equal(parsed.exports.length, 100);
        equal(Object.keys(parsed.definitions).length, 100);
      } finally {
        await cleanupTempWorkspace(workspaceDir);
      }
    });
  });
});
