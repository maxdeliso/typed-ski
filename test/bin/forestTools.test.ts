/**
 * Forest Tools CLI Tests
 *
 * Tests for the SKI evaluation forest generation tools:
 * - genForest: generates evaluation forest data
 * - genSvg: generates SVG visualizations from forest data
 */

import { expect } from "chai";
import { dirname, fromFileUrl, join } from "std/path";
import { existsSync } from "std/fs";

const __dirname = dirname(fromFileUrl(import.meta.url));
const projectRoot = join(__dirname, "../..");

// Import library functions for testing
import { generateEvaluationForest } from "../../bin/genForest.ts";
import type {
  EvaluationPath,
  GlobalInfo,
} from "../../lib/shared/forestTypes.ts";
import {
  isValidEvaluationPath,
  isValidGlobalInfo,
} from "../../lib/shared/forestTypes.ts";

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
  const tempFile = join(projectRoot, `test_forest_${Date.now()}.jsonl`);
  await Deno.writeTextFile(tempFile, content);
  return tempFile;
}

async function cleanupTestFile(filePath: string): Promise<void> {
  try {
    await Deno.remove(filePath);
  } catch {
    // Ignore cleanup errors
  }
}

Deno.test("Forest Tools CLI Tests", async (t) => {
  await t.step("genForest CLI", async (t) => {
    await t.step("--help flag", async () => {
      const result = await runCommand([
        "deno",
        "run",
        "--allow-read",
        "--allow-write",
        "--allow-run",
        "bin/genForest.ts",
        "--help",
      ]);

      expect(result.success).to.be.true;
      expect(result.stdout).to.include("SKI Evaluation Forest Generator");
      expect(result.stdout).to.include("USAGE:");
    });

    await t.step("--version flag", async () => {
      const result = await runCommand([
        "deno",
        "run",
        "--allow-read",
        "--allow-write",
        "--allow-run",
        "bin/genForest.ts",
        "--version",
      ]);

      expect(result.success).to.be.true;
      expect(result.stdout.trim()).to.match(/^genForest v\d+\.\d+\.\d+$/);
    });

    await t.step("error handling for missing arguments", async () => {
      const result = await runCommand([
        "deno",
        "run",
        "--allow-read",
        "--allow-write",
        "--allow-run",
        "bin/genForest.ts",
      ]);

      expect(result.success).to.be.false;
      expect(result.stderr).to.include("symbolCount is required");
    });

    await t.step("error handling for invalid symbol count", async () => {
      const result = await runCommand([
        "deno",
        "run",
        "--allow-read",
        "--allow-write",
        "--allow-run",
        "bin/genForest.ts",
        "invalid",
      ]);

      expect(result.success).to.be.false;
      expect(result.stderr).to.include("must be a positive integer");
    });

    await t.step("generates forest data for small input", async () => {
      const testFile = await createTestFile("");

      try {
        const result = await runCommand([
          "deno",
          "run",
          "--allow-read",
          "--allow-write",
          "--allow-run",
          "bin/genForest.ts",
          "2",
          testFile,
        ]);

        expect(result.success).to.be.true;
        expect(existsSync(testFile)).to.be.true;

        const content = await Deno.readTextFile(testFile);
        const lines = content.trim().split("\n");

        // Should have evaluation paths + global info
        expect(lines.length).to.be.greaterThan(1);

        // Check that last line is global info
        const lastLine = JSON.parse(lines[lines.length - 1]);
        expect(lastLine).to.have.property("type", "global");
        expect(lastLine).to.have.property("nodes");
        expect(lastLine).to.have.property("sources");
        expect(lastLine).to.have.property("sinks");

        // Check that other lines are evaluation paths
        for (let i = 0; i < lines.length - 1; i++) {
          const path = JSON.parse(lines[i]);
          expect(path).to.have.property("source");
          expect(path).to.have.property("sink");
          expect(path).to.have.property("steps");
          expect(path).to.have.property("hasCycle");
        }
      } finally {
        await cleanupTestFile(testFile);
      }
    });
  });

  await t.step("genSvg CLI", async (t) => {
    await t.step("--help flag", async () => {
      const result = await runCommand([
        "deno",
        "run",
        "--allow-read",
        "--allow-write",
        "--allow-run",
        "bin/genSvg.ts",
        "--help",
      ]);

      expect(result.success).to.be.true;
      expect(result.stdout).to.include("SKI Evaluation Forest SVG Generator");
      expect(result.stdout).to.include("USAGE:");
    });

    await t.step("--version flag", async () => {
      const result = await runCommand([
        "deno",
        "run",
        "--allow-read",
        "--allow-write",
        "--allow-run",
        "bin/genSvg.ts",
        "--version",
      ]);

      expect(result.success).to.be.true;
      expect(result.stdout.trim()).to.match(/^genSvg v\d+\.\d+\.\d+$/);
    });

    await t.step("error handling for missing arguments", async () => {
      const result = await runCommand([
        "deno",
        "run",
        "--allow-read",
        "--allow-write",
        "--allow-run",
        "bin/genSvg.ts",
      ]);

      expect(result.success).to.be.false;
      expect(result.stderr).to.include("symbolCount is required");
    });

    await t.step("error handling for invalid symbol count", async () => {
      const result = await runCommand([
        "deno",
        "run",
        "--allow-read",
        "--allow-write",
        "--allow-run",
        "bin/genSvg.ts",
        "invalid",
      ]);

      expect(result.success).to.be.false;
      expect(result.stderr).to.include("must be a positive integer");
    });

    await t.step("error handling for invalid input file", async () => {
      const result = await runCommand([
        "deno",
        "run",
        "--allow-read",
        "--allow-write",
        "--allow-run",
        "bin/genSvg.ts",
        "2",
        "nonexistent.jsonl",
      ]);

      expect(result.success).to.be.false;
      expect(result.stderr).to.include("Error reading file");
    });
  });

  await t.step("Library function tests", async (t) => {
    await t.step("generateEvaluationForest works", async () => {
      const results: string[] = [];

      for await (const data of generateEvaluationForest(2)) {
        results.push(data);
      }

      expect(results.length).to.be.greaterThan(1);

      // Check that last result is global info
      const globalInfo = JSON.parse(results[results.length - 1]);
      expect(globalInfo).to.have.property("type", "global");
      expect(globalInfo).to.have.property("nodes");
      expect(globalInfo).to.have.property("sources");
      expect(globalInfo).to.have.property("sinks");

      // Check that other results are evaluation paths
      for (let i = 0; i < results.length - 1; i++) {
        const path = JSON.parse(results[i]);
        expect(path).to.have.property("source");
        expect(path).to.have.property("sink");
        expect(path).to.have.property("steps");
        expect(path).to.have.property("hasCycle");
      }
    });
  });

  await t.step("Type validation tests", async (t) => {
    await t.step("isValidGlobalInfo works", () => {
      const validGlobalInfo: GlobalInfo = {
        type: "global",
        nodes: [],
        sources: [1, 2, 3],
        sinks: [4, 5, 6],
      };

      expect(isValidGlobalInfo(validGlobalInfo)).to.be.true;
      expect(isValidGlobalInfo({})).to.be.false;
      expect(isValidGlobalInfo(null)).to.be.false;
      expect(isValidGlobalInfo("invalid")).to.be.false;
    });

    await t.step("isValidEvaluationPath works", () => {
      const validPath: EvaluationPath = {
        source: 1,
        sink: 2,
        steps: [{ from: 1, to: 2 }],
        hasCycle: false,
      };

      expect(isValidEvaluationPath(validPath)).to.be.true;
      expect(isValidEvaluationPath({})).to.be.false;
      expect(isValidEvaluationPath(null)).to.be.false;
      expect(isValidEvaluationPath("invalid")).to.be.false;
    });
  });

  await t.step("CLI file structure tests", async (t) => {
    await t.step("CLI files exist", () => {
      const binDir = join(projectRoot, "bin");

      expect(existsSync(join(binDir, "genForest.ts"))).to.be.true;
      expect(existsSync(join(binDir, "genSvg.ts"))).to.be.true;
    });

    await t.step("CLI files have proper shebang", async () => {
      const genForestTs = await Deno.readTextFile(
        join(projectRoot, "bin/genForest.ts"),
      );
      expect(genForestTs).to.include(
        "#!/usr/bin/env -S deno run --allow-read --allow-write --allow-run",
      );

      const genSvgTs = await Deno.readTextFile(
        join(projectRoot, "bin/genSvg.ts"),
      );
      expect(genSvgTs).to.include(
        "#!/usr/bin/env -S deno run --allow-read --allow-write --allow-run",
      );
    });

    // Shell wrapper tests removed - using Deno tasks instead
  });

  await t.step("Deno task integration", async (t) => {
    await t.step("deno task genForest --help", async () => {
      const result = await runCommand(["deno", "task", "genForest", "--help"]);

      expect(result.success).to.be.true;
      expect(result.stdout).to.include("SKI Evaluation Forest Generator");
    });

    await t.step("deno task genSvg --help", async () => {
      const result = await runCommand(["deno", "task", "genSvg", "--help"]);

      expect(result.success).to.be.true;
      expect(result.stdout).to.include("SKI Evaluation Forest SVG Generator");
    });
  });
});
