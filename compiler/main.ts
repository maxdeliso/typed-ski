#!/usr/bin/env -S node --experimental-transform-types

/**
 * TripLang Compiler CLI
 *
 * Phase 1: Single-File Compiler & Object Format (.tripc)
 *
 * This tool processes one .trip file and outputs a standardized intermediate
 * "object file" (.tripc) that can be linked with other modules in later phases.
 *
 * Usage: node --experimental-transform-types compiler/main.ts <input.trip> [output.tripc]
 */

import { statSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SingleFileCompilerError } from "../lib/compiler/index.ts";
import { serializeTripCObject } from "../lib/compiler/objectFile.ts";
import { loadTripModuleObject } from "../lib/tripSourceLoader.ts";

/**
 * Compilation error specific to the CLI
 */
class CompilerCLIError extends Error {
  constructor(
    message: string,
    public override readonly cause?: unknown,
  ) {
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
    // Compile source file with import metadata from discoverable sibling modules.
    console.log(`Loading ${inputPath}...`);
    console.log("Compiling TripLang program...");
    const objectFile = await loadTripModuleObject(inputPath);
    const serialized = serializeTripCObject(objectFile);

    // Determine output path
    const finalOutputPath =
      outputPath || inputPath.replace(/\.trip$/, ".tripc");

    // Write object file
    console.log(`Writing object file to ${finalOutputPath}...`);
    await writeFile(finalOutputPath, serialized, "utf8");

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
      process.exit(1);
    } else if (error instanceof CompilerCLIError) {
      console.error(`Compilation error: ${error.message}`);
      process.exit(1);
    } else {
      console.error(`Unexpected error: ${error}`);
      process.exit(1);
    }
  }
}

/**
 * Main CLI entry point
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const [inputArg, outputArg] = args;

  if (!inputArg) {
    console.error(
      "Usage: node --experimental-transform-types compiler/main.ts <input.trip> [output.tripc]",
    );
    console.error("");
    console.error("Examples:");
    console.error(
      "  node --experimental-transform-types compiler/main.ts mymodule.trip",
    );
    console.error(
      "  node --experimental-transform-types compiler/main.ts mymodule.trip mymodule.tripc",
    );
    process.exit(1);
  }

  const inputPath = resolve(inputArg);
  const outputPath = outputArg ? resolve(outputArg) : undefined;

  // Validate input file exists and has .trip extension
  try {
    const stat = statSync(inputPath);
    if (!stat.isFile()) {
      throw new Error("Input path is not a file");
    }
  } catch (error) {
    console.error(`Cannot read input file '${inputPath}': ${error}`);
    process.exit(1);
  }

  if (!inputPath.endsWith(".trip")) {
    console.error(`Input file must have .trip extension: ${inputPath}`);
    process.exit(1);
  }

  await compileToObjectFile(inputPath, outputPath);
}

const isMain =
  process.argv[1] &&
  (fileURLToPath(import.meta.url) === resolve(process.argv[1]) ||
    process.argv[1].endsWith("compiler/main.ts"));

if (isMain) {
  await main();
}
