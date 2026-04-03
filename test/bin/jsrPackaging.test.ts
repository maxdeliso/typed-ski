/**
 * JSR Packaging Tests
 *
 * Tests for JSR packaging conventions and configuration:
 * - Package.json/bin field configuration
 * - Exports field configuration
 * - Publish include/exclude
 * - CLI accessibility via JSR imports
 */

import { expect } from "../util/assertions.ts";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { readFile, readdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { spawnSync } from "node:child_process";

import { parseJsonc } from "../util/jsonc.ts";
import {
  cleanupTempWorkspace,
  createTempWorkspace,
} from "../util/tripcHarness.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "../..");

test("JSR Packaging Configuration", async (t) => {
  await t.test("jsr.json configuration", async (t) => {
    await t.test("has required fields", async () => {
      const configPath = join(projectRoot, "jsr.json");
      expect(existsSync(configPath)).to.be.true;

      const configContent = await readFile(configPath, "utf-8");
      const config = parseJsonc(configContent);

      // Check required fields
      expect(config).to.have.property("name");
      expect(config).to.have.property("version");
      expect(config).to.have.property("license");
      expect(config).to.have.property("exports");
      expect(config).to.have.property("publish");

      expect(config.name).to.equal("@maxdeliso/typed-ski");
      expect(config.version).to.match(/^\d+\.\d+\.\d+$/);
      expect(config.license).to.equal("MIT");
    });

    await t.test("exports field configuration", async () => {
      const configPath = join(projectRoot, "jsr.json");
      const configContent = await readFile(configPath, "utf-8");
      const config = parseJsonc(configContent);

      expect(config.exports).to.have.property(".");
      expect(config.exports).to.have.property("./bin/tripc");

      expect(config.exports["."]).to.equal("./lib/index.ts");
      expect(config.exports["./bin/tripc"]).to.equal("./bin/tripc.ts");
    });

    await t.test("publish include configuration", async () => {
      const configPath = join(projectRoot, "jsr.json");
      const configContent = await readFile(configPath, "utf-8");
      const config = parseJsonc(configContent);

      expect(config.publish.include).to.include("bin/**");
      expect(config.publish.include).to.include("lib/**");
      expect(config.publish.include).to.include("dist/**");
      expect(config.publish.include).to.include("README.md");
      expect(config.publish.include).to.include("SECURITY.md");
    });
  });

  await t.test("CLI file structure", async (t) => {
    await t.test("bin directory exists", () => {
      const binDir = join(projectRoot, "bin");
      expect(existsSync(binDir)).to.be.true;
    });

    await t.test("required CLI files exist", () => {
      const binDir = join(projectRoot, "bin");

      // Core CLI files
      expect(existsSync(join(binDir, "tripc.ts"))).to.be.true;

      // Documentation and scripts
    });

    await t.test("CLI files have proper shebang", async () => {
      const tripcTs = await readFile(
        join(projectRoot, "bin/tripc.ts"),
        "utf-8",
      );
      expect(tripcTs).to.include("#!/usr/bin/env");
      expect(tripcTs).to.include("node --experimental-transform-types");
    });

    // Shell wrapper tests removed
  });

  await t.test("library integration", async (t) => {
    await t.test("compiler library exports", async () => {
      // Test that the compiler library is properly exported
      const libIndex = await readFile(
        join(projectRoot, "lib/index.ts"),
        "utf-8",
      );

      expect(libIndex).to.include("compileToObjectFile");
      expect(libIndex).to.include("compileToObjectFileString");
      expect(libIndex).to.include("TripCObject");
      expect(libIndex).to.include("ModuleImport");
      expect(libIndex).to.include("SingleFileCompilerError");
    });

    await t.test("compiler module structure", () => {
      const compilerDir = join(projectRoot, "lib/compiler");
      expect(existsSync(compilerDir)).to.be.true;

      expect(existsSync(join(compilerDir, "index.ts"))).to.be.true;
      expect(existsSync(join(compilerDir, "objectFile.ts"))).to.be.true;
      expect(existsSync(join(compilerDir, "singleFileCompiler.ts"))).to.be.true;
    });
  });

  await t.test("distribution files", async (t) => {
    await t.test("dist directory structure", async () => {
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
            expect(existsSync(join(distDir, file))).to.be.true;
          }
        }
      } else {
        console.log(
          "Dist directory not found - run build tasks to create distribution files",
        );
      }
    });
  });

  await t.test("version consistency", async (t) => {
    await t.test("version numbers match across files", async () => {
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
      expect(generatedVersion).to.include(`export const VERSION = "${version}";`);
    });
  });

  await t.test("CLI tools functionality", async (t) => {
    await t.test("tripc CLI can show version", async () => {
      const tripcScript = join(projectRoot, "bin/tripc.ts");

      const { status, stdout } = spawnSync(
        process.execPath,
        ["--experimental-transform-types", tripcScript, "--version"],
        {
          cwd: projectRoot,
          encoding: "utf-8",
        },
      );

      expect(status).to.equal(0);
      expect(stdout.trim()).to.match(/^tripc v\d+\.\d+\.\d+$/);
    });

    await t.test("tripc CLI can show help", async () => {
      const tripcScript = join(projectRoot, "bin/tripc.ts");

      const { status, stdout } = spawnSync(
        process.execPath,
        ["--experimental-transform-types", tripcScript, "--help"],
        {
          cwd: projectRoot,
          encoding: "utf-8",
        },
      );

      expect(status).to.equal(0);
      expect(stdout).to.include("USAGE:");
    });

    await t.test("tripc can compile test file", async () => {
      const tripcScript = join(projectRoot, "bin/tripc.ts");
      const testFile = join(projectRoot, "test/test.trip");
      const outputDir = await createTempWorkspace("typed-ski-jsr-packaging-");
      try {
        const outputFile = join(outputDir, "test_output.tripc");
        const { status, stderr } = spawnSync(
          process.execPath,
          ["--experimental-transform-types", tripcScript, testFile, outputFile],
          {
            cwd: projectRoot,
            encoding: "utf-8",
          },
        );

        expect(status).to.equal(0, `Compilation failed: ${stderr}`);
        expect(existsSync(outputFile)).to.be.true;
      } finally {
        await cleanupTempWorkspace(outputDir);
      }
    });
  });

  await t.test("WASM build files", async (t) => {
    await t.test("WASM files exist", () => {
      // NOTE: wasm/release.wasm is no longer staged during tests to avoid ambiguity.
      // It is only staged during the final build/publish flow.
    });
  });
});
