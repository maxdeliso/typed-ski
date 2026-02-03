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
import { parseSKI } from "../../lib/parser/ski.ts";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

Deno.test("TripLang Linker Integration", async (t) => {
  await t.step("full pipeline: compile + link simple expression", async () => {
    // Step 1: Create a simple TripLang source file
    const simpleSource = `module Simple

export main

poly main = #X => \\x: X => x`;

    const sourceFile = `${__dirname}/int_simple.trip`;
    await Deno.writeTextFile(sourceFile, simpleSource);

    try {
      // Step 2: Compile to .tripc
      const compileCommand = new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          "--allow-read",
          "--allow-write",
          "../../bin/tripc.ts",
          "int_simple.trip",
          "int_simple.tripc",
        ],
        cwd: __dirname,
      });

      const { code: compileCode } = await compileCommand.output();
      expect(compileCode).to.equal(0);

      // Step 3: Link the .tripc file
      const linkCommand = new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          "--allow-read",
          "--allow-write",
          "../../bin/tripc.ts",
          "--link",
          "int_simple.tripc",
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
        await Deno.remove(`${__dirname}/int_simple.tripc`);
      } catch {
        // Ignore cleanup errors
      }
    }
  });

  await t.step("full pipeline: compile + link complex expression", async () => {
    // Step 1: Create a complex TripLang source file
    const complexSource = `module Complex

export main

poly main = #X => \\x: X => \\y: X => \\z: X => x`;

    const sourceFile = `${__dirname}/int_complex.trip`;
    await Deno.writeTextFile(sourceFile, complexSource);

    try {
      // Step 2: Compile to .tripc
      const compileCommand = new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          "--allow-read",
          "--allow-write",
          "../../bin/tripc.ts",
          "int_complex.trip",
          "int_complex.tripc",
        ],
        cwd: __dirname,
      });

      const { code: compileCode } = await compileCommand.output();
      expect(compileCode).to.equal(0);

      // Step 3: Link the .tripc file
      const linkCommand = new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          "--allow-read",
          "--allow-write",
          "../../bin/tripc.ts",
          "--link",
          "int_complex.tripc",
        ],
        cwd: __dirname,
      });

      const { stdout, code: linkCode } = await linkCommand.output();
      const output = new TextDecoder().decode(stdout);

      expect(linkCode).to.equal(0);
      expect(output).to.include("K");
      expect(() => parseSKI(output.trim())).to.not.throw();
    } finally {
      // Cleanup
      try {
        await Deno.remove(sourceFile);
        await Deno.remove(`${__dirname}/int_complex.tripc`);
      } catch {
        // Ignore cleanup errors
      }
    }
  });

  await t.step("full pipeline: compile + link multiple modules", async () => {
    // Step 1: Create multiple TripLang source files
    const moduleASource = `module ModuleA

export addA

poly addA = #X => \\x: X => \\y: X => x`;

    const moduleBSource = `module ModuleB

export main

poly main = #X => \\x: X => x`;

    const sourceFileA = `${__dirname}/int_mod_a.trip`;
    const sourceFileB = `${__dirname}/int_mod_b.trip`;

    await Deno.writeTextFile(sourceFileA, moduleASource);
    await Deno.writeTextFile(sourceFileB, moduleBSource);

    try {
      // Step 2: Compile both modules
      const compileACommand = new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          "--allow-read",
          "--allow-write",
          "../../bin/tripc.ts",
          "int_mod_a.trip",
          "int_mod_a.tripc",
        ],
        cwd: __dirname,
      });

      const compileBCommand = new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          "--allow-read",
          "--allow-write",
          "../../bin/tripc.ts",
          "int_mod_b.trip",
          "int_mod_b.tripc",
        ],
        cwd: __dirname,
      });

      const { code: compileACode } = await compileACommand.output();
      const { code: compileBCode } = await compileBCommand.output();

      expect(compileACode).to.equal(0);
      expect(compileBCode).to.equal(0);

      // Step 3: Link both modules
      const linkCommand = new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          "--allow-read",
          "--allow-write",
          "../../bin/tripc.ts",
          "--link",
          "int_mod_a.tripc",
          "int_mod_b.tripc",
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
        await Deno.remove(`${__dirname}/int_mod_a.tripc`);
        await Deno.remove(`${__dirname}/int_mod_b.tripc`);
      } catch {
        // Ignore cleanup errors
      }
    }
  });

  await t.step("handles compilation errors gracefully", async () => {
    // Step 1: Create invalid TripLang source file
    const invalidSource = `module Invalid

export main

poly main = \\x:Int => \\y:Int => x + y`;

    const sourceFile = `${__dirname}/int_invalid.trip`;
    await Deno.writeTextFile(sourceFile, invalidSource);

    try {
      // Step 2: Try to compile (should fail)
      const compileCommand = new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          "--allow-read",
          "--allow-write",
          "../../bin/tripc.ts",
          "int_invalid.trip",
          "int_invalid.tripc",
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
        await Deno.remove(`${__dirname}/int_invalid.tripc`);
      } catch {
        // Ignore cleanup errors
      }
    }
  });

  await t.step("handles linking errors gracefully", async () => {
    // Step 1: Create TripLang source without main
    const noMainSource = `module NoMain

export other

typed other = \\x: Int => x`;

    const sourceFile = `${__dirname}/int_noMain.trip`;
    await Deno.writeTextFile(sourceFile, noMainSource);

    try {
      // Step 2: Compile to .tripc
      const compileCommand = new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          "--allow-read",
          "--allow-write",
          "../../bin/tripc.ts",
          "int_noMain.trip",
          "int_noMain.tripc",
        ],
        cwd: __dirname,
      });

      const { code: compileCode } = await compileCommand.output();
      expect(compileCode).to.equal(0);

      // Step 3: Try to link (should fail)
      const linkCommand = new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          "--allow-read",
          "--allow-write",
          "../../bin/tripc.ts",
          "--link",
          "int_noMain.tripc",
        ],
        cwd: __dirname,
      });

      const { stderr, code: linkCode } = await linkCommand.output();
      const errorOutput = new TextDecoder().decode(stderr);

      expect(linkCode).to.not.equal(0);
      // The linker now reports unresolved symbols before checking for main
      expect(errorOutput).to.match(
        /No 'main' function found|Symbol.*is not defined/,
      );
    } finally {
      // Cleanup
      try {
        await Deno.remove(sourceFile);
        await Deno.remove(`${__dirname}/int_noMain.tripc`);
      } catch {
        // Ignore cleanup errors
      }
    }
  });

  await t.step("performance: handles large expressions", async () => {
    // Step 1: Create a large TripLang source file
    const largeSource = `module Large

export main

poly main = #X => \\x: X => \\y: X => \\z: X => \\w: X => \\v: X => \\u: X => \\t: X => \\s: X => \\r: X => \\q: X => x`;

    const sourceFile = `${__dirname}/int_large.trip`;
    await Deno.writeTextFile(sourceFile, largeSource);

    try {
      // Step 2: Compile to .tripc
      const compileCommand = new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          "--allow-read",
          "--allow-write",
          "../../bin/tripc.ts",
          "int_large.trip",
          "int_large.tripc",
        ],
        cwd: __dirname,
      });

      const { code: compileCode } = await compileCommand.output();
      expect(compileCode).to.equal(0);

      // Step 3: Link the .tripc file
      const linkCommand = new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          "--allow-read",
          "--allow-write",
          "../../bin/tripc.ts",
          "--link",
          "int_large.tripc",
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
        await Deno.remove(`${__dirname}/int_large.tripc`);
      } catch {
        // Ignore cleanup errors
      }
    }
  });

  await t.step("executable wrapper integration", async () => {
    const sourceFile = `${__dirname}/int_exec_wrapper.trip`;
    const tripcFile = `${__dirname}/int_exec_wrapper.tripc`;
    const source = `module ExecWrapper

export main

poly main = #X => \\x: X => x`;

    await Deno.writeTextFile(sourceFile, source);
    try {
      const compileCommand = new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          "--allow-read",
          "--allow-write",
          "../../bin/tripc.ts",
          "int_exec_wrapper.trip",
          "int_exec_wrapper.tripc",
        ],
        cwd: __dirname,
      });

      const { code: compileCode } = await compileCommand.output();
      expect(compileCode).to.equal(0);

      const command = new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          "--allow-read",
          "--allow-write",
          "../../bin/tripc.ts",
          "--link",
          "int_exec_wrapper.tripc",
        ],
        cwd: __dirname,
      });

      const { stdout, code } = await command.output();
      const output = new TextDecoder().decode(stdout);

      expect(code).to.equal(0);
      expect(output).to.be.a("string");
      expect(output.length).to.be.greaterThan(0);
    } finally {
      try {
        await Deno.remove(sourceFile);
        await Deno.remove(tripcFile);
      } catch {
        // Ignore cleanup errors
      }
    }
  });
});
