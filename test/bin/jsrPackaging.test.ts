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
import { workspaceRoot } from "../../lib/shared/workspaceRoot.ts";
import { VERSION as generatedVersionConstant } from "../../lib/shared/version.generated.ts";
import { spawnSync } from "node:child_process";

import { parseJsonc } from "../util/jsonc.ts";
import {
  cleanupTempWorkspace,
  createTempWorkspace,
} from "../util/tripcHarness.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const jsRoot = join(__dirname, "../..");
const srcRoot = workspaceRoot;

describe("JSR Packaging Configuration", () => {
  describe("jsr.json configuration", () => {
    it("has required fields", async () => {
      const configPath = join(srcRoot, "jsr.json");
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
      const configPath = join(srcRoot, "jsr.json");
      const configContent = await readFile(configPath, "utf-8");
      const config = parseJsonc(configContent) as any;

      assert.ok(config.exports !== undefined);
      assert.ok("./bin/tripc" in config.exports);

      assert.strictEqual(config.exports["."], "./lib/index.ts");
      assert.strictEqual(config.exports["./bin/tripc"], "./bin/tripc.ts");
    });

    it("publish include configuration", async () => {
      const configPath = join(srcRoot, "jsr.json");
      const configContent = await readFile(configPath, "utf-8");
      const config = parseJsonc(configContent) as any;

      assert.ok(config.publish.include.includes("bin/**"));
      assert.ok(config.publish.include.includes("lib/**"));
      assert.ok(config.publish.include.includes("dist/**"));
      assert.ok(config.publish.include.includes("README.md"));
      assert.ok(config.publish.include.includes("SECURITY.md"));
    });

    it("uses Deno's built-in Node types without requiring node_modules", async () => {
      const configPath = join(srcRoot, "jsr.json");
      const configContent = await readFile(configPath, "utf-8");
      const config = parseJsonc(configContent) as any;

      assert.ok(!("types" in config.compilerOptions));
      assert.ok(!("@types/node" in config.imports));
    });
  });

  describe("CLI file structure", () => {
    it("bin directory exists", () => {
      const binDir = join(srcRoot, "bin");
      assert.strictEqual(existsSync(binDir), true);
    });

    it("required CLI files exist", () => {
      const binDir = join(srcRoot, "bin");

      // Core CLI files
      assert.strictEqual(existsSync(join(binDir, "tripc.ts")), true);

      // Documentation and scripts
    });

    it("CLI files have proper shebang", async () => {
      const tripcTs = await readFile(join(srcRoot, "bin/tripc.ts"), "utf-8");
      assert.ok(
        tripcTs.includes(
          "#!/usr/bin/env -S node --disable-warning=ExperimentalWarning",
        ),
      );
    });

    // Shell wrapper tests removed
  });

  describe("library integration", () => {
    it("compiler library exports", async () => {
      // Guards the slim public API surface. Internal symbols (TripCObject,
      // compileToObjectFile, MiniCore IR types, Bundle-v1 helpers, etc.) are
      // intentionally not re-exported from lib/index.ts; they remain
      // importable from their specific module paths but are not part of the
      // stable contract.
      const libIndex = await readFile(join(srcRoot, "lib/index.ts"), "utf-8");

      assert.ok(libIndex.includes("compile"));
      assert.ok(libIndex.includes("compileTripSourceToLlvm"));
      assert.ok(libIndex.includes("parseSKI"));
      assert.ok(libIndex.includes("unparseSKI"));
      assert.ok(libIndex.includes("bracketLambda"));
      assert.ok(libIndex.includes("typecheckSystemF"));
      assert.ok(!libIndex.includes("create" + "Thana" + "tosEvaluator"));
      assert.ok(libIndex.includes("getPreludeObject"));
    });

    it("compiler module structure", () => {
      const compilerDir = join(srcRoot, "lib/compiler");
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
      const distDir = join(srcRoot, "dist");

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
      const packageJsonPath = join(srcRoot, "package.json");
      const packageJson = JSON.parse(await readFile(packageJsonPath, "utf-8"));
      const version = packageJson.version;

      const jsrJsonPath = join(srcRoot, "jsr.json");
      const jsrJson = JSON.parse(await readFile(jsrJsonPath, "utf-8"));
      assert.strictEqual(jsrJson.version, version);

      // Read the VERSION via static import rather than file-system probe.
      // The .ts source file is not materialized as a real file in Windows
      // Bazel runfiles (MANIFEST-only), and the static import covers the
      // same intent — verify the codegen-emitted constant matches
      // package.json — without depending on path resolution.
      assert.strictEqual(generatedVersionConstant, version);
    });
  });

  describe("CLI tools functionality", () => {
    it("tripc CLI can show version", async () => {
      const tripcScript = join(jsRoot, "bin/tripc.js");

      const { status, stdout } = spawnSync(
        process.execPath,
        ["--disable-warning=ExperimentalWarning", tripcScript, "--version"],
        {
          cwd: jsRoot,
          encoding: "utf-8",
        },
      );

      assert.strictEqual(status, 0);
      assert.match(stdout.trim(), /^tripc v\d+\.\d+\.\d+$/);
    });

    it("tripc CLI can show help", async () => {
      const tripcScript = join(jsRoot, "bin/tripc.js");

      const { status, stdout } = spawnSync(
        process.execPath,
        ["--disable-warning=ExperimentalWarning", tripcScript, "--help"],
        {
          cwd: jsRoot,
          encoding: "utf-8",
        },
      );

      assert.strictEqual(status, 0);
      assert.ok(stdout.includes("USAGE:"));
    });

    it("tripc can emit LLVM for a test file", async () => {
      const tripcScript = join(jsRoot, "bin/tripc.js");
      const testFile = join(srcRoot, "test/compiler/llvm/helloWorld.trip");
      const outputDir = await createTempWorkspace("typed-ski-jsr-packaging-");
      try {
        const outputFile = join(outputDir, "test_output.ll");
        const { status, stderr } = spawnSync(
          process.execPath,
          [
            "--disable-warning=ExperimentalWarning",
            tripcScript,
            "--emit",
            "llvm",
            testFile,
            outputFile,
            "--entry-module",
            "Main",
            "--module-source",
            "Prelude=lib/prelude.trip",
            "--emit-main-wrapper",
          ],
          {
            cwd: jsRoot,
            encoding: "utf-8",
          },
        );

        assert.strictEqual(status, 0, `LLVM emission failed: ${stderr}`);
        assert.strictEqual(existsSync(outputFile), true);
      } finally {
        await cleanupTempWorkspace(outputDir);
      }
    });
  });
});
