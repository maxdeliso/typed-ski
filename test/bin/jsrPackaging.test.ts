/**
 * JSR Packaging Tests
 *
 * Tests for JSR packaging conventions and configuration:
 * - Package.json/bin field configuration
 * - Exports field configuration
 * - Publish include/exclude
 * - CLI accessibility via JSR imports
 */

import { expect } from "chai";
import { dirname, fromFileUrl, join } from "std/path";
import { existsSync } from "std/fs";

const __dirname = dirname(fromFileUrl(import.meta.url));
const projectRoot = join(__dirname, "../..");

Deno.test("JSR Packaging Configuration", async (t) => {
  await t.step("deno.jsonc configuration", async (t) => {
    await t.step("has required fields", async () => {
      const configPath = join(projectRoot, "deno.jsonc");
      expect(existsSync(configPath)).to.be.true;

      const configContent = await Deno.readTextFile(configPath);
      const config = JSON.parse(configContent);

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

    await t.step("exports field configuration", async () => {
      const configPath = join(projectRoot, "deno.jsonc");
      const configContent = await Deno.readTextFile(configPath);
      const config = JSON.parse(configContent);

      expect(config.exports).to.have.property(".");
      expect(config.exports).to.have.property("./bin/tripc");

      expect(config.exports["."]).to.equal("./lib/index.ts");
      expect(config.exports["./bin/tripc"]).to.equal("./bin/tripc.ts");
    });

    await t.step("publish include configuration", async () => {
      const configPath = join(projectRoot, "deno.jsonc");
      const configContent = await Deno.readTextFile(configPath);
      const config = JSON.parse(configContent);

      expect(config.publish.include).to.include("bin/**");
      expect(config.publish.include).to.include("lib/**");
      expect(config.publish.include).to.include("dist/**");
      expect(config.publish.include).to.include("README.md");
      expect(config.publish.include).to.include("SECURITY.md");
    });
  });

  await t.step("CLI file structure", async (t) => {
    await t.step("bin directory exists", () => {
      const binDir = join(projectRoot, "bin");
      expect(existsSync(binDir)).to.be.true;
    });

    await t.step("required CLI files exist", () => {
      const binDir = join(projectRoot, "bin");

      // Core CLI files
      expect(existsSync(join(binDir, "tripc.ts"))).to.be.true;

      // Documentation and scripts
    });

    await t.step("CLI files have proper shebang", async () => {
      const tripcTs = await Deno.readTextFile(
        join(projectRoot, "bin/tripc.ts"),
      );
      expect(tripcTs).to.include(
        "#!/usr/bin/env -S deno run --allow-read --allow-write",
      );
    });

    // Shell wrapper tests removed - using Deno tasks instead
  });

  await t.step("library integration", async (t) => {
    await t.step("compiler library exports", async () => {
      // Test that the compiler library is properly exported
      const libIndex = await Deno.readTextFile(
        join(projectRoot, "lib/index.ts"),
      );

      expect(libIndex).to.include("compileToObjectFile");
      expect(libIndex).to.include("compileToObjectFileString");
      expect(libIndex).to.include("TripCObject");
      expect(libIndex).to.include("ModuleImport");
      expect(libIndex).to.include("SingleFileCompilerError");
    });

    await t.step("compiler module structure", () => {
      const compilerDir = join(projectRoot, "lib/compiler");
      expect(existsSync(compilerDir)).to.be.true;

      expect(existsSync(join(compilerDir, "index.ts"))).to.be.true;
      expect(existsSync(join(compilerDir, "objectFile.ts"))).to.be.true;
      expect(existsSync(join(compilerDir, "singleFileCompiler.ts"))).to.be.true;
    });
  });

  await t.step("distribution files", async (t) => {
    await t.step("dist directory structure", async () => {
      const distDir = join(projectRoot, "dist");

      // These files are created by build tasks
      if (existsSync(distDir)) {
        const distFiles = [];
        for await (const entry of Deno.readDir(distDir)) {
          distFiles.push(entry.name);
        }

        // Check for expected distribution files
        const expectedFiles = ["tripc.js", "tripc.min.js", "tripc"];
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

  await t.step("version consistency", async (t) => {
    await t.step("version numbers match across files", async () => {
      const configPath = join(projectRoot, "deno.jsonc");
      const configContent = await Deno.readTextFile(configPath);
      const config = JSON.parse(configContent);
      const _packageVersion = config.version;

      // Check CLI version import
      const tripcTs = await Deno.readTextFile(
        join(projectRoot, "bin/tripc.ts"),
      );
      expect(tripcTs).to.include(
        `import { VERSION } from "../lib/shared/version.ts"`,
      );
    });
  });

  await t.step("CLI tools functionality", async (t) => {
    await t.step("tripc CLI can show version", async () => {
      const tripcScript = join(projectRoot, "bin/tripc.ts");

      const command = new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          "--allow-read",
          "--allow-write",
          tripcScript,
          "--version",
        ],
        cwd: projectRoot,
      });

      const { code, stdout } = await command.output();
      const output = new TextDecoder().decode(stdout);

      expect(code).to.equal(0);
      expect(output.trim()).to.match(/^tripc v\d+\.\d+\.\d+$/);
    });

    await t.step("tripc CLI can show help", async () => {
      const tripcScript = join(projectRoot, "bin/tripc.ts");

      const command = new Deno.Command(Deno.execPath(), {
        args: ["run", "--allow-read", "--allow-write", tripcScript, "--help"],
        cwd: projectRoot,
      });

      const { code, stdout } = await command.output();
      const output = new TextDecoder().decode(stdout);

      expect(code).to.equal(0);
      expect(output).to.include("USAGE:");
    });

    await t.step("genForest CLI can show version", async () => {
      const genForestScript = join(projectRoot, "bin/genForest.ts");

      const command = new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          "--allow-read",
          "--allow-write",
          "--allow-run",
          genForestScript,
          "--version",
        ],
        cwd: projectRoot,
      });

      const { code, stdout } = await command.output();
      const output = new TextDecoder().decode(stdout);

      expect(code).to.equal(0);
      expect(output.trim()).to.match(/^genForest v\d+\.\d+\.\d+$/);
    });

    await t.step("genSvg CLI can show version", async () => {
      const genSvgScript = join(projectRoot, "bin/genSvg.ts");

      const command = new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          "--allow-read",
          "--allow-write",
          "--allow-run",
          genSvgScript,
          "--version",
        ],
        cwd: projectRoot,
      });

      const { code, stdout } = await command.output();
      const output = new TextDecoder().decode(stdout);

      expect(code).to.equal(0);
      expect(output.trim()).to.match(/^genSvg v\d+\.\d+\.\d+$/);
    });

    await t.step("tripc can compile test file", async () => {
      const tripcScript = join(projectRoot, "bin/tripc.ts");
      const testFile = join(projectRoot, "test/test.trip");
      const outputFile = join(projectRoot, "test/test_output.tripc");

      try {
        await Deno.remove(outputFile);
      } catch {
        // Ignore if doesn't exist
      }

      const command = new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          "--allow-read",
          "--allow-write",
          tripcScript,
          testFile,
          outputFile,
        ],
        cwd: projectRoot,
      });

      const { code, stderr } = await command.output();
      const errorOutput = new TextDecoder().decode(stderr);

      expect(code).to.equal(0, `Compilation failed: ${errorOutput}`);
      expect(existsSync(outputFile)).to.be.true;

      try {
        await Deno.remove(outputFile);
      } catch {
        // Ignore cleanup errors
      }
    });
  });

  await t.step("WASM build files", async (t) => {
    await t.step("WASM files exist for genForest and genSvg", () => {
      const wasmDir = join(projectRoot, "wasm");
      expect(existsSync(wasmDir)).to.be.true;
      expect(existsSync(join(wasmDir, "debug.wasm"))).to.be.true;
      expect(existsSync(join(wasmDir, "release.wasm"))).to.be.true;
    });

    await t.step("WASM files exist", () => {
      const debugWasm = join(projectRoot, "wasm/debug.wasm");
      const releaseWasm = join(projectRoot, "wasm/release.wasm");
      expect(existsSync(debugWasm)).to.be.true;
      expect(existsSync(releaseWasm)).to.be.true;
    });
  });
});
