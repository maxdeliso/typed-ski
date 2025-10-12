/**
 * Integration tests for the TripLang Linker
 *
 * This test suite validates end-to-end workflows including:
 * - Compilation + Linking pipeline
 * - Different expression types
 * - Error scenarios
 * - Performance characteristics
 */

import { expect } from "chai";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

Deno.test("TripLang Linker Integration", async (t) => {
  await t.step("full pipeline: compile + link simple expression", async () => {
    // Step 1: Create a simple TripLang source file
    const simpleSource = `module Simple

export main

poly main = ΛX. λx: X. x`;

    const sourceFile = `${__dirname}/simple.trip`;
    await Deno.writeTextFile(sourceFile, simpleSource);

    try {
      // Step 2: Compile to .tripc
      const compileCommand = new Deno.Command("deno", {
        args: [
          "run",
          "--allow-read",
          "--allow-write",
          "../../bin/tripc.ts",
          "simple.trip",
          "simple.tripc",
        ],
        cwd: __dirname,
      });

      const { code: compileCode } = await compileCommand.output();
      expect(compileCode).to.equal(0);

      // Step 3: Link the .tripc file
      const linkCommand = new Deno.Command("deno", {
        args: [
          "run",
          "--allow-read",
          "--allow-write",
          "../../bin/tripc.ts",
          "--link",
          "simple.tripc",
        ],
        cwd: __dirname,
      });

      const { stdout, code: linkCode } = await linkCommand.output();
      const output = new TextDecoder().decode(stdout);

      expect(linkCode).to.equal(0);
      expect(output.trim()).to.equal("I");
    } finally {
      // Cleanup
      try {
        await Deno.remove(sourceFile);
        await Deno.remove(`${__dirname}/simple.tripc`);
      } catch {
        // Ignore cleanup errors
      }
    }
  });

  await t.step("full pipeline: compile + link complex expression", async () => {
    // Step 1: Create a complex TripLang source file
    const complexSource = `module Complex

export main

poly main = ΛX. λx: X. λy: X. λz: X. x`;

    const sourceFile = `${__dirname}/complex_test.trip`;
    await Deno.writeTextFile(sourceFile, complexSource);

    try {
      // Step 2: Compile to .tripc
      const compileCommand = new Deno.Command("deno", {
        args: [
          "run",
          "--allow-read",
          "--allow-write",
          "../../bin/tripc.ts",
          "complex_test.trip",
          "complex_test.tripc",
        ],
        cwd: __dirname,
      });

      const { code: compileCode } = await compileCommand.output();
      expect(compileCode).to.equal(0);

      // Step 3: Link the .tripc file
      const linkCommand = new Deno.Command("deno", {
        args: [
          "run",
          "--allow-read",
          "--allow-write",
          "../../bin/tripc.ts",
          "--link",
          "complex_test.tripc",
        ],
        cwd: __dirname,
      });

      const { stdout, code: linkCode } = await linkCommand.output();
      const output = new TextDecoder().decode(stdout);

      expect(linkCode).to.equal(0);
      expect(output).to.include("S");
      expect(output).to.include("K");
      expect(output).to.include("(");
    } finally {
      // Cleanup
      try {
        await Deno.remove(sourceFile);
        await Deno.remove(`${__dirname}/complex_test.tripc`);
      } catch {
        // Ignore cleanup errors
      }
    }
  });

  await t.step("full pipeline: compile + link multiple modules", async () => {
    // Step 1: Create multiple TripLang source files
    const moduleASource = `module ModuleA

export addA

poly addA = ΛX. λx: X. λy: X. x`;

    const moduleBSource = `module ModuleB

export main

poly main = ΛX. λx: X. x`;

    const sourceFileA = `${__dirname}/moduleA.trip`;
    const sourceFileB = `${__dirname}/moduleB.trip`;

    await Deno.writeTextFile(sourceFileA, moduleASource);
    await Deno.writeTextFile(sourceFileB, moduleBSource);

    try {
      // Step 2: Compile both modules
      const compileACommand = new Deno.Command("deno", {
        args: [
          "run",
          "--allow-read",
          "--allow-write",
          "../../bin/tripc.ts",
          "moduleA.trip",
          "moduleA.tripc",
        ],
        cwd: __dirname,
      });

      const compileBCommand = new Deno.Command("deno", {
        args: [
          "run",
          "--allow-read",
          "--allow-write",
          "../../bin/tripc.ts",
          "moduleB.trip",
          "moduleB.tripc",
        ],
        cwd: __dirname,
      });

      const { code: compileACode } = await compileACommand.output();
      const { code: compileBCode } = await compileBCommand.output();

      expect(compileACode).to.equal(0);
      expect(compileBCode).to.equal(0);

      // Step 3: Link both modules
      const linkCommand = new Deno.Command("deno", {
        args: [
          "run",
          "--allow-read",
          "--allow-write",
          "../../bin/tripc.ts",
          "--link",
          "moduleA.tripc",
          "moduleB.tripc",
        ],
        cwd: __dirname,
      });

      const { stdout, code: linkCode } = await linkCommand.output();
      const output = new TextDecoder().decode(stdout);

      expect(linkCode).to.equal(0);
      expect(output).to.be.a("string");
      expect(output.length).to.be.greaterThan(0);
    } finally {
      // Cleanup
      try {
        await Deno.remove(sourceFileA);
        await Deno.remove(sourceFileB);
        await Deno.remove(`${__dirname}/moduleA.tripc`);
        await Deno.remove(`${__dirname}/moduleB.tripc`);
      } catch {
        // Ignore cleanup errors
      }
    }
  });

  await t.step("handles compilation errors gracefully", async () => {
    // Step 1: Create invalid TripLang source file
    const invalidSource = `module Invalid

export main

poly main = λx:Int. λy:Int. x + y`;

    const sourceFile = `${__dirname}/invalid.trip`;
    await Deno.writeTextFile(sourceFile, invalidSource);

    try {
      // Step 2: Try to compile (should fail)
      const compileCommand = new Deno.Command("deno", {
        args: [
          "run",
          "--allow-read",
          "--allow-write",
          "../../bin/tripc.ts",
          "invalid.trip",
          "invalid.tripc",
        ],
        cwd: __dirname,
      });

      const { stderr, code: compileCode } = await compileCommand.output();
      const errorOutput = new TextDecoder().decode(stderr);

      expect(compileCode).to.not.equal(0);
      expect(errorOutput).to.include("Compilation error");
    } finally {
      // Cleanup
      try {
        await Deno.remove(sourceFile);
        await Deno.remove(`${__dirname}/invalid.tripc`);
      } catch {
        // Ignore cleanup errors
      }
    }
  });

  await t.step("handles linking errors gracefully", async () => {
    // Step 1: Create TripLang source without main
    const noMainSource = `module NoMain

export other

typed other = λx: Int. x`;

    const sourceFile = `${__dirname}/noMain.trip`;
    await Deno.writeTextFile(sourceFile, noMainSource);

    try {
      // Step 2: Compile to .tripc
      const compileCommand = new Deno.Command("deno", {
        args: [
          "run",
          "--allow-read",
          "--allow-write",
          "../../bin/tripc.ts",
          "noMain.trip",
          "noMain.tripc",
        ],
        cwd: __dirname,
      });

      const { code: compileCode } = await compileCommand.output();
      expect(compileCode).to.equal(0);

      // Step 3: Try to link (should fail)
      const linkCommand = new Deno.Command("deno", {
        args: [
          "run",
          "--allow-read",
          "--allow-write",
          "../../bin/tripc.ts",
          "--link",
          "noMain.tripc",
        ],
        cwd: __dirname,
      });

      const { stderr, code: linkCode } = await linkCommand.output();
      const errorOutput = new TextDecoder().decode(stderr);

      expect(linkCode).to.not.equal(0);
      // The linker now reports unresolved symbols before checking for main
      expect(errorOutput).to.match(/No 'main' function found|Unresolved/);
    } finally {
      // Cleanup
      try {
        await Deno.remove(sourceFile);
        await Deno.remove(`${__dirname}/noMain.tripc`);
      } catch {
        // Ignore cleanup errors
      }
    }
  });

  await t.step("performance: handles large expressions", async () => {
    // Step 1: Create a large TripLang source file
    const largeSource = `module Large

export main

poly main = ΛX. λx: X. λy: X. λz: X. λw: X. λv: X. λu: X. λt: X. λs: X. λr: X. λq: X. x`;

    const sourceFile = `${__dirname}/large.trip`;
    await Deno.writeTextFile(sourceFile, largeSource);

    try {
      // Step 2: Compile to .tripc
      const compileCommand = new Deno.Command("deno", {
        args: [
          "run",
          "--allow-read",
          "--allow-write",
          "../../bin/tripc.ts",
          "large.trip",
          "large.tripc",
        ],
        cwd: __dirname,
      });

      const { code: compileCode } = await compileCommand.output();
      expect(compileCode).to.equal(0);

      // Step 3: Link the .tripc file
      const linkCommand = new Deno.Command("deno", {
        args: [
          "run",
          "--allow-read",
          "--allow-write",
          "../../bin/tripc.ts",
          "--link",
          "large.tripc",
        ],
        cwd: __dirname,
      });

      const { stdout, code: linkCode } = await linkCommand.output();
      const output = new TextDecoder().decode(stdout);

      expect(linkCode).to.equal(0);
      expect(output).to.be.a("string");
      expect(output.length).to.be.greaterThan(0);
    } finally {
      // Cleanup
      try {
        await Deno.remove(sourceFile);
        await Deno.remove(`${__dirname}/large.tripc`);
      } catch {
        // Ignore cleanup errors
      }
    }
  });

  await t.step("executable wrapper integration", async () => {
    // Compile A.trip to A.tripc first
    const compileCommand = new Deno.Command("deno", {
      args: [
        "run",
        "--allow-read",
        "--allow-write",
        "../../bin/tripc.ts",
        "A.trip",
        "A.tripc",
      ],
      cwd: __dirname,
    });

    const { code: compileCode } = await compileCommand.output();
    expect(compileCode).to.equal(0);

    // Test the executable wrapper directly
    const command = new Deno.Command("../../bin/tripc", {
      args: ["--link", "A.tripc"],
      cwd: __dirname,
    });

    const { stdout, code } = await command.output();
    const output = new TextDecoder().decode(stdout);

    expect(code).to.equal(0);
    expect(output).to.be.a("string");
    expect(output.length).to.be.greaterThan(0);
  });
});
