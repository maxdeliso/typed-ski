#!/usr/bin/env deno run --allow-read --allow-write

/**
 * TripLang Compiler CLI
 *
 * Phase 1: Single-File Compiler & Object Format (.tripc)
 *
 * This tool processes one .trip file and outputs a standardized intermediate
 * "object file" (.tripc) that can be linked with other modules in later phases.
 *
 * Usage: deno run --allow-read --allow-write compiler/main.ts <input.trip> [output.tripc]
 */

import { resolve } from "std/path";
import {
  compileToObjectFileString,
  SingleFileCompilerError,
} from "../lib/compiler/index.ts";

/**
 * Compilation error specific to the CLI
 */
class CompilerCLIError extends Error {
  constructor(message: string, public override readonly cause?: unknown) {
    super(message);
    this.name = "CompilerCLIError";
  }
}

/**
 * Compiles a single .trip file to a .tripc object file
 */
async function compileToObjectFile(
  inputPath: string,
  outputPath?: string,
): Promise<void> {
  try {
    // Read input file
    console.log(`Reading ${inputPath}...`);
    const inputContent = await Deno.readTextFile(inputPath);

    // Compile to object file string
    console.log("Compiling TripLang program...");
    const serialized = compileToObjectFileString(inputContent);

    // Determine output path
    const finalOutputPath = outputPath ||
      inputPath.replace(/\.trip$/, ".tripc");

    // Write object file
    console.log(`Writing object file to ${finalOutputPath}...`);
    await Deno.writeTextFile(finalOutputPath, serialized);

    // Parse the serialized output to get stats for display
    const objectFile = JSON.parse(serialized);

    console.log("Compilation successful!");
    console.log(`   Module: ${objectFile.module}`);
    console.log(`   Imports: ${objectFile.imports.length}`);
    console.log(`   Exports: ${objectFile.exports.length}`);
    console.log(
      `   Definitions: ${Object.keys(objectFile.definitions).length}`,
    );
    console.log(`   Output: ${finalOutputPath}`);
  } catch (error) {
    if (error instanceof SingleFileCompilerError) {
      console.error(`Compilation error: ${error.message}`);
      Deno.exit(1);
    } else if (error instanceof CompilerCLIError) {
      console.error(`Compilation error: ${error.message}`);
      Deno.exit(1);
    } else {
      console.error(`Unexpected error: ${error}`);
      Deno.exit(1);
    }
  }
}

/**
 * Main CLI entry point
 */
async function main(): Promise<void> {
  const args = Deno.args;

  if (args.length === 0) {
    console.error(
      "Usage: deno run --allow-read --allow-write compiler/main.ts <input.trip> [output.tripc]",
    );
    console.error("");
    console.error("Examples:");
    console.error(
      "  deno run --allow-read --allow-write compiler/main.ts mymodule.trip",
    );
    console.error(
      "  deno run --allow-read --allow-write compiler/main.ts mymodule.trip mymodule.tripc",
    );
    Deno.exit(1);
  }

  const inputPath = resolve(args[0]);
  const outputPath = args[1] ? resolve(args[1]) : undefined;

  // Validate input file exists and has .trip extension
  try {
    const stat = Deno.statSync(inputPath);
    if (!stat.isFile) {
      throw new Error("Input path is not a file");
    }
  } catch (error) {
    console.error(`Cannot read input file '${inputPath}': ${error}`);
    Deno.exit(1);
  }

  if (!inputPath.endsWith(".trip")) {
    console.error(`Input file must have .trip extension: ${inputPath}`);
    Deno.exit(1);
  }

  await compileToObjectFile(inputPath, outputPath);
}

// Run the CLI if this file is executed directly
if (import.meta.main) {
  await main();
}
