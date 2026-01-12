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
import type { EvaluationPath } from "../../lib/shared/forestTypes.ts";
import { isValidEvaluationPath } from "../../lib/shared/forestTypes.ts";

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

Deno.test("Forest Tools CLI Tests", async (t) => {
  await t.step("genForest CLI", async (t) => {
    await t.step("--help flag", async () => {
      const result = await runCommand([
        "deno",
        "run",
        "--allow-read",
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
        "--allow-run",
        "bin/genForest.ts",
        "invalid",
      ]);

      expect(result.success).to.be.false;
      expect(result.stderr).to.include("must be a positive integer");
    });

    await t.step("generates forest data for small input", async () => {
      const result = await runCommand([
        "deno",
        "run",
        "--allow-read",
        "--allow-run",
        "bin/genForest.ts",
        "2",
      ]);

      expect(result.success).to.be.true;

      const lines = result.stdout.trim().split("\n");

      // Should have evaluation paths + global info
      expect(lines.length).to.be.greaterThan(1);

      // Check that lines are evaluation paths (skip nodeLabel objects)
      for (let i = 0; i < lines.length; i++) {
        const obj = JSON.parse(lines[i]);
        // Skip nodeLabel objects
        if (obj.type === "nodeLabel") {
          continue;
        }
        expect(obj).to.have.property("source");
        expect(obj).to.have.property("sink");
        expect(obj).to.have.property("steps");
        expect(obj).to.have.property("expr");
        expect(obj).to.have.property("reachedNormalForm");
        expect(obj).to.have.property("stepsTaken");
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
      expect(result.stdout + result.stderr).to.include("Error reading file");
    });
  });

  await t.step("Library function tests", async (t) => {
    await t.step("generateEvaluationForest works", async () => {
      const results: string[] = [];

      for await (const data of generateEvaluationForest(2)) {
        // Handle both EvalResult objects and string (global info)
        if (typeof data === "string") {
          results.push(data);
        } else {
          // Stringify EvalResult objects
          results.push(JSON.stringify(data));
        }
      }

      expect(results.length).to.be.greaterThan(1);

      // Check that results are evaluation paths (skip nodeLabel objects)
      for (let i = 0; i < results.length; i++) {
        const obj = JSON.parse(results[i]);
        // Skip nodeLabel objects
        if (obj.type === "nodeLabel") {
          continue;
        }
        expect(obj).to.have.property("source");
        expect(obj).to.have.property("sink");
        expect(obj).to.have.property("steps");
        expect(obj).to.have.property("expr");
        expect(obj).to.have.property("reachedNormalForm");
        expect(obj).to.have.property("stepsTaken");
      }
    });
  });

  await t.step("Type validation tests", async (t) => {
    await t.step("isValidEvaluationPath works", () => {
      const validPath: EvaluationPath = {
        expr: "II",
        source: 1,
        sink: 2,
        steps: [{ from: 1, to: 2 }],
        reachedNormalForm: true,
        stepsTaken: 1,
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
        "#!/usr/bin/env -S deno run --allow-read --allow-run",
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
