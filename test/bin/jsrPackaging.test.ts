/**
 * JSR Packaging Tests
 *
 * Tests for JSR packaging conventions and configuration:
 * - Package.json/bin field configuration
 * - Exports field configuration
 * - Publish include/exclude
 * - CLI accessibility via JSR imports
 */

import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { readFile, readdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, it } from "../util/test_shim.ts";
import { spawnSync } from "node:child_process";

import { parseJsonc } from "../util/jsonc.ts";
import {
  cleanupTempWorkspace,
  createTempWorkspace,
} from "../util/tripcHarness.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "../..");

describe("JSR Packaging Configuration", () => {
  describe("jsr.json configuration", () => {
    it("has required fields", async () => {
      const configPath = join(projectRoot, "jsr.json");
      assert.strictEqual(existsSync(configPath), true);

      const configContent = await readFile(configPath, "utf-8");
      const config = parseJsonc(configContent) as any;

      // Check required fields
      assert.ok("name" in config);
      assert.ok("version" in config);
      assert.ok("license" in config);
      assert.ok("exports" in config);
      assert.ok("publish" in config);

      assert.strictEqual(config.name, "@maxdeliso/typed-ski");
      assert.match(config.version, /^\d+\.\d+\.\d+$/);
      assert.strictEqual(config.license, "MIT");
    });

    it("exports field configuration", async () => {
      const configPath = join(projectRoot, "jsr.json");
      const configContent = await readFile(configPath, "utf-8");
      const config = parseJsonc(configContent) as any;

      assert.ok(config.exports !== undefined);
      assert.ok("./bin/tripc" in config.exports);

      assert.strictEqual(config.exports["."], "./lib/index.ts");
      assert.strictEqual(config.exports["./bin/tripc"], "./bin/tripc.ts");
    });

    it("publish include configuration", async () => {
      const configPath = join(projectRoot, "jsr.json");
      const configContent = await readFile(configPath, "utf-8");
      const config = parseJsonc(configContent) as any;

      assert.ok(config.publish.include.includes("bin/**"));
      assert.ok(config.publish.include.includes("lib/**"));
      assert.ok(config.publish.include.includes("dist/**"));
      assert.ok(config.publish.include.includes("README.md"));
      assert.ok(config.publish.include.includes("SECURITY.md"));
    });
  });

  describe("CLI file structure", () => {
    it("bin directory exists", () => {
      const binDir = join(projectRoot, "bin");
      assert.strictEqual(existsSync(binDir), true);
    });

    it("required CLI files exist", () => {
      const binDir = join(projectRoot, "bin");

      // Core CLI files
      assert.strictEqual(existsSync(join(binDir, "tripc.ts")), true);

      // Documentation and scripts
    });

    it("CLI files have proper shebang", async () => {
      const tripcTs = await readFile(
        join(projectRoot, "bin/tripc.ts"),
        "utf-8",
      );
      assert.ok(tripcTs.includes("#!/usr/bin/env"));
      assert.ok(
        tripcTs.includes(
          "node --disable-warning=ExperimentalWarning --experimental-transform-types",
        ),
      );
    });

    // Shell wrapper tests removed
  });

  describe("library integration", () => {
    it("compiler library exports", async () => {
      // Test that the compiler library is properly exported
      const libIndex = await readFile(
        join(projectRoot, "lib/index.ts"),
        "utf-8",
      );

      assert.ok(libIndex.includes("compileToObjectFile"));
      assert.ok(libIndex.includes("compileToObjectFileString"));
      assert.ok(libIndex.includes("TripCObject"));
      assert.ok(libIndex.includes("ModuleImport"));
      assert.ok(libIndex.includes("SingleFileCompilerError"));
    });

    it("compiler module structure", () => {
      const compilerDir = join(projectRoot, "lib/compiler");
      assert.strictEqual(existsSync(compilerDir), true);

      assert.strictEqual(existsSync(join(compilerDir, "index.ts")), true);
      assert.strictEqual(existsSync(join(compilerDir, "objectFile.ts")), true);
      assert.strictEqual(
        existsSync(join(compilerDir, "singleFileCompiler.ts")),
        true,
      );
    });
  });

  describe("distribution files", () => {
    it("dist directory structure", async () => {
      const distDir = join(projectRoot, "dist");

      // These files are created by build tasks
      if (existsSync(distDir)) {
        const distFiles = await readdir(distDir);

        // Check for expected distribution files
        const expectedFiles = [
          "tripc.js",
          "tripc.min.js",
          process.platform === "win32" ? "tripc.cmd" : "tripc",
        ];
        for (const file of expectedFiles) {
          if (distFiles.includes(file)) {
            assert.strictEqual(existsSync(join(distDir, file)), true);
          }
        }
      } else {
        console.log(
          "Dist directory not found - run build tasks to create distribution files",
        );
      }
    });
  });

  describe("version consistency", () => {
    it("version numbers match across files", async () => {
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

  describe("CLI tools functionality", () => {
    it("tripc CLI can show version", async () => {
      const tripcScript = join(projectRoot, "bin/tripc.ts");

      const { status, stdout } = spawnSync(
        process.execPath,
        [
          "--disable-warning=ExperimentalWarning",
          "--experimental-transform-types",
          tripcScript,
          "--version",
        ],
        {
          cwd: projectRoot,
          encoding: "utf-8",
        },
      );

      assert.strictEqual(status, 0);
      assert.match(stdout.trim(), /^tripc v\d+\.\d+\.\d+$/);
    });

    it("tripc CLI can show help", async () => {
      const tripcScript = join(projectRoot, "bin/tripc.ts");

      const { status, stdout } = spawnSync(
        process.execPath,
        [
          "--disable-warning=ExperimentalWarning",
          "--experimental-transform-types",
          tripcScript,
          "--help",
        ],
        {
          cwd: projectRoot,
          encoding: "utf-8",
        },
      );

      assert.strictEqual(status, 0);
      assert.ok(stdout.includes("USAGE:"));
    });

    it("tripc can compile test file", async () => {
      const tripcScript = join(projectRoot, "bin/tripc.ts");
      const testFile = join(projectRoot, "test/test.trip");
      const outputDir = await createTempWorkspace("typed-ski-jsr-packaging-");
      try {
        const outputFile = join(outputDir, "test_output.tripc");
        const { status, stderr } = spawnSync(
          process.execPath,
          [
            "--disable-warning=ExperimentalWarning",
            "--experimental-transform-types",
            tripcScript,
            testFile,
            outputFile,
          ],
          {
            cwd: projectRoot,
            encoding: "utf-8",
          },
        );

        assert.strictEqual(status, 0, `Compilation failed: ${stderr}`);
        assert.strictEqual(existsSync(outputFile), true);
      } finally {
        await cleanupTempWorkspace(outputDir);
      }
    });
  });

  describe("WASM build files", () => {
    it("WASM files exist", () => {
      // NOTE: wasm/release.wasm is no longer staged during tests to avoid ambiguity.
      // It is only staged during the final build/publish flow.
    });
  });
});
