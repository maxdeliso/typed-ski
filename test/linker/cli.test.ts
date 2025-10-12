/**
 * Tests for the TripLang Linker CLI
 *
 * This test suite validates the command-line interface including:
 * - Argument parsing
 * - Help and version output
 * - File validation
 * - Error handling
 */

import { expect } from "chai";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Helper function to compile a .trip file to .tripc format
 */
async function compileTripFile(tripFileName: string): Promise<void> {
  const compileCommand = new Deno.Command("deno", {
    args: [
      "run",
      "--allow-read",
      "--allow-write",
      "../../bin/tripc.ts",
      tripFileName,
      tripFileName.replace(".trip", ".tripc"),
    ],
    cwd: __dirname,
  });

  const { code } = await compileCommand.output();
  if (code !== 0) {
    throw new Error(`Failed to compile ${tripFileName}`);
  }
}

Deno.test("TripLang Linker CLI", async (t) => {
  // Setup: Compile required .trip files to .tripc
  await t.step("setup: compile test files", async () => {
    await compileTripFile("A.trip");
    await compileTripFile("B.trip");
    await compileTripFile("complex.trip");
  });
  await t.step("shows help message", async () => {
    const command = new Deno.Command("deno", {
      args: [
        "run",
        "--allow-read",
        "--allow-write",
        "../../bin/tripc.ts",
        "--link",
        "--help",
      ],
      cwd: __dirname,
    });

    const { stdout, stderr: _stderr, code } = await command.output();
    const output = new TextDecoder().decode(stdout);

    expect(code).to.equal(0);
    expect(output).to.include("TripLang Compiler & Linker");
    expect(output).to.include("USAGE:");
    expect(output).to.include("OPTIONS:");
    expect(output).to.include("EXAMPLES:");
  });

  await t.step("shows version information", async () => {
    const command = new Deno.Command("deno", {
      args: [
        "run",
        "--allow-read",
        "--allow-write",
        "../../bin/tripc.ts",
        "--link",
        "--version",
      ],
      cwd: __dirname,
    });

    const { stdout, stderr: _stderr, code } = await command.output();
    const output = new TextDecoder().decode(stdout);

    expect(code).to.equal(0);
    expect(output.trim()).to.match(/^tripc v\d+\.\d+\.\d+$/);
  });

  await t.step("accepts short help flag", async () => {
    const command = new Deno.Command("deno", {
      args: [
        "run",
        "--allow-read",
        "--allow-write",
        "../../bin/tripc.ts",
        "--link",
        "-h",
      ],
      cwd: __dirname,
    });

    const { stdout, stderr: _stderr, code } = await command.output();
    const output = new TextDecoder().decode(stdout);

    expect(code).to.equal(0);
    expect(output).to.include("TripLang Compiler & Linker");
  });

  await t.step("accepts short version flag", async () => {
    const command = new Deno.Command("deno", {
      args: [
        "run",
        "--allow-read",
        "--allow-write",
        "../../bin/tripc.ts",
        "--link",
        "-v",
      ],
      cwd: __dirname,
    });

    const { stdout, stderr: _stderr, code } = await command.output();
    const output = new TextDecoder().decode(stdout);

    expect(code).to.equal(0);
    expect(output.trim()).to.match(/^tripc v\d+\.\d+\.\d+$/);
  });

  await t.step("accepts verbose flag", async () => {
    const command = new Deno.Command("deno", {
      args: [
        "run",
        "--allow-read",
        "--allow-write",
        "../../bin/tripc.ts",
        "--link",
        "--verbose",
        "A.tripc",
      ],
      cwd: __dirname,
    });

    const { stdout, stderr, code } = await command.output();
    const stdoutText = new TextDecoder().decode(stdout);
    const stderrText = new TextDecoder().decode(stderr);

    expect(code).to.equal(0);
    expect(stdoutText).to.be.a("string");
    expect(stderrText).to.include("Linking");
  });

  await t.step("accepts short verbose flag", async () => {
    const command = new Deno.Command("deno", {
      args: [
        "run",
        "--allow-read",
        "--allow-write",
        "../../bin/tripc.ts",
        "--link",
        "-V",
        "A.tripc",
      ],
      cwd: __dirname,
    });

    const { stdout, stderr, code } = await command.output();
    const stdoutText = new TextDecoder().decode(stdout);
    const stderrText = new TextDecoder().decode(stderr);

    expect(code).to.equal(0);
    expect(stdoutText).to.be.a("string");
    expect(stderrText).to.include("Linking");
  });

  await t.step("links single .tripc file", async () => {
    const command = new Deno.Command("deno", {
      args: [
        "run",
        "--allow-read",
        "--allow-write",
        "../../bin/tripc.ts",
        "--link",
        "A.tripc",
      ],
      cwd: __dirname,
    });

    const { stdout, stderr: _stderr, code } = await command.output();
    const output = new TextDecoder().decode(stdout);

    expect(code).to.equal(0);
    expect(output).to.be.a("string");
    expect(output.length).to.be.greaterThan(0);
  });

  await t.step("links multiple .tripc files", async () => {
    // Create a helper module without main to avoid ambiguous exports
    const helperSource = `module Helper

export helper

poly helper = ΛX. λx: X. x`;

    const helperFile = `${__dirname}/helper.trip`;
    await Deno.writeTextFile(helperFile, helperSource);

    // Compile the helper module
    const compileCommand = new Deno.Command("deno", {
      args: [
        "run",
        "--allow-read",
        "--allow-write",
        "../../bin/tripc.ts",
        "helper.trip",
        "helper.tripc",
      ],
      cwd: __dirname,
    });

    const { code: compileCode } = await compileCommand.output();
    if (compileCode !== 0) {
      throw new Error("Failed to compile helper module");
    }

    // Now link A.tripc with helper.tripc (only A has main)
    const command = new Deno.Command("deno", {
      args: [
        "run",
        "--allow-read",
        "--allow-write",
        "../../bin/tripc.ts",
        "--link",
        "A.tripc",
        "helper.tripc",
      ],
      cwd: __dirname,
    });

    const { stdout, stderr: _stderr, code } = await command.output();
    const output = new TextDecoder().decode(stdout);

    // Clean up
    try {
      await Deno.remove(helperFile);
      await Deno.remove(`${__dirname}/helper.tripc`);
    } catch {
      // Ignore cleanup errors
    }

    expect(code).to.equal(0);
    expect(output).to.be.a("string");
    expect(output.length).to.be.greaterThan(0);
  });

  await t.step("links complex expression", async () => {
    const command = new Deno.Command("deno", {
      args: [
        "run",
        "--allow-read",
        "--allow-write",
        "../../bin/tripc.ts",
        "--link",
        "complex.tripc",
      ],
      cwd: __dirname,
    });

    const { stdout, stderr: _stderr, code } = await command.output();
    const output = new TextDecoder().decode(stdout);

    expect(code).to.equal(0);
    expect(output).to.include("S");
    expect(output).to.include("K");
    expect(output).to.include("(");
  });

  await t.step("rejects non-.tripc files", async () => {
    const command = new Deno.Command("deno", {
      args: [
        "run",
        "--allow-read",
        "--allow-write",
        "../../bin/tripc.ts",
        "--link",
        "A.trip",
      ],
      cwd: __dirname,
    });

    const { stdout: _stdout, stderr, code } = await command.output();
    const stderrText = new TextDecoder().decode(stderr);

    expect(code).to.equal(1);
    expect(stderrText).to.include("Input file must have .tripc extension");
  });

  await t.step("rejects non-existent files", async () => {
    const command = new Deno.Command("deno", {
      args: [
        "run",
        "--allow-read",
        "--allow-write",
        "../../bin/tripc.ts",
        "--link",
        "nonexistent.tripc",
      ],
      cwd: __dirname,
    });

    const { stdout: _stdout, stderr, code } = await command.output();
    const stderrText = new TextDecoder().decode(stderr);

    expect(code).to.equal(1);
    expect(stderrText).to.include("Input file does not exist");
  });

  await t.step("rejects empty argument list", async () => {
    const command = new Deno.Command("deno", {
      args: [
        "run",
        "--allow-read",
        "--allow-write",
        "../../bin/tripc.ts",
        "--link",
      ],
      cwd: __dirname,
    });

    const { stdout: _stdout, stderr, code } = await command.output();
    const stderrText = new TextDecoder().decode(stderr);

    expect(code).to.equal(1);
    expect(stderrText).to.include("No input files specified");
  });

  await t.step("handles mixed valid and invalid files", async () => {
    // Create a temporary file with wrong extension to test extension validation
    const tempFile = `${__dirname}/temp.txt`;
    await Deno.writeTextFile(tempFile, "some content");

    try {
      const command = new Deno.Command("deno", {
        args: [
          "run",
          "--allow-read",
          "--allow-write",
          "../../bin/tripc.ts",
          "--link",
          "A.tripc",
          "temp.txt",
          "B.tripc",
        ],
        cwd: __dirname,
      });

      const { stdout: _stdout, stderr, code } = await command.output();
      const stderrText = new TextDecoder().decode(stderr);

      expect(code).to.equal(1);
      expect(stderrText).to.include("Input file must have .tripc extension");
    } finally {
      // Clean up temporary file
      try {
        await Deno.remove(tempFile);
      } catch {
        // Ignore cleanup errors
      }
    }
  });

  await t.step("executable wrapper works", async () => {
    const command = new Deno.Command("../../bin/tripc", {
      args: ["--link", "--help"],
      cwd: __dirname,
    });

    const { stdout, stderr: _stderr, code } = await command.output();
    const output = new TextDecoder().decode(stdout);

    expect(code).to.equal(0);
    expect(output).to.include("TripLang Compiler & Linker");
  });
});
