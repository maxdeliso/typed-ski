#!/usr/bin/env -S deno run --allow-read --allow-write

/**
 * TripLang Compiler CLI (tripc)
 *
 * A redistributable command-line tool for compiling TripLang modules to object files.
 *
 * Usage:
 *   tripc <input.trip> [output.tripc]
 *   tripc --help
 *   tripc --version
 *
 * Examples:
 *   tripc mymodule.trip
 *   tripc mymodule.trip mymodule.tripc
 *   tripc --help
 */

import { resolve } from "std/path";
import {
  compileToObjectFileString,
  SingleFileCompilerError,
} from "../lib/compiler/index.ts";
import { VERSION } from "../lib/shared/version.ts";

interface CLIOptions {
  help: boolean;
  version: boolean;
  verbose: boolean;
}

function parseArgs(
  args: string[],
): { options: CLIOptions; inputPath?: string; outputPath?: string } {
  const options: CLIOptions = {
    help: false,
    version: false,
    verbose: false,
  };

  let inputPath: string | undefined;
  let outputPath: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    switch (arg) {
      case "--help":
      case "-h":
        options.help = true;
        break;
      case "--version":
      case "-v":
        options.version = true;
        break;
      case "--verbose":
        options.verbose = true;
        break;
      default:
        if (arg.startsWith("-")) {
          console.error(`Unknown option: ${arg}`);
          console.error("Use --help for usage information.");
          Deno.exit(1);
        }

        if (!inputPath) {
          inputPath = arg;
        } else if (!outputPath) {
          outputPath = arg;
        } else {
          console.error(
            "Too many arguments. Use --help for usage information.",
          );
          Deno.exit(1);
        }
        break;
    }
  }

  return { options, inputPath, outputPath };
}

function showHelp(): void {
  console.log(`
TripLang Compiler (tripc) v${VERSION}

USAGE:
    tripc <input.trip> [output.tripc]
    tripc [OPTIONS]

ARGUMENTS:
    <input.trip>     Input TripLang source file
    [output.tripc]   Output object file (optional, defaults to input.tripc)

OPTIONS:
    -h, --help       Show this help message
    -v, --version    Show version information
    --verbose        Enable verbose output

EXAMPLES:
    tripc mymodule.trip
    tripc mymodule.trip mymodule.tripc
    tripc --help
    tripc --version

DESCRIPTION:
    Compiles a single TripLang module (.trip) into a standardized object file (.tripc).
    This is Phase 1 of the TripLang module system - single-file compilation.

    The object file contains:
    - Module name and metadata
    - Import/export declarations
    - Elaborated definitions ready for linking
`);
}

function showVersion(): void {
  console.log(`tripc v${VERSION}`);
}

async function compileFile(
  inputPath: string,
  outputPath?: string,
  verbose = false,
): Promise<void> {
  try {
    if (verbose) {
      console.log(`Reading ${inputPath}...`);
    }

    const inputContent = await Deno.readTextFile(inputPath);

    if (verbose) {
      console.log("Compiling TripLang program...");
    }

    const serialized = compileToObjectFileString(inputContent);

    const finalOutputPath = outputPath ||
      inputPath.replace(/\.trip$/, ".tripc");

    if (verbose) {
      console.log(`Writing object file to ${finalOutputPath}...`);
    }

    await Deno.writeTextFile(finalOutputPath, serialized);

    // Parse the serialized output to get stats for display
    const objectFile = JSON.parse(serialized);

    if (verbose) {
      console.log(`   Module: ${objectFile.module}`);
      console.log(`   Imports: ${objectFile.imports.length}`);
      console.log(`   Exports: ${objectFile.exports.length}`);
      console.log(
        `   Definitions: ${Object.keys(objectFile.definitions).length}`,
      );
      console.log(`   Output: ${finalOutputPath}`);
    }
  } catch (error) {
    if (error instanceof SingleFileCompilerError) {
      console.error(`Compilation error: ${error.message}`);
      Deno.exit(1);
    } else if (error instanceof Deno.errors.NotFound) {
      console.error(`File not found: ${inputPath}`);
      Deno.exit(1);
    } else if (error instanceof Deno.errors.PermissionDenied) {
      console.error(`Permission denied: ${error.message}`);
      Deno.exit(1);
    } else {
      console.error(`Unexpected error: ${error}`);
      Deno.exit(1);
    }
  }
}

async function main(): Promise<void> {
  const args = Deno.args;
  const { options, inputPath, outputPath } = parseArgs(args);

  if (options.help) {
    showHelp();
    return;
  }

  if (options.version) {
    showVersion();
    return;
  }

  if (!inputPath) {
    console.error("Error: No input file specified.");
    console.error("Use --help for usage information.");
    Deno.exit(1);
  }

  const resolvedInputPath = resolve(inputPath);

  try {
    const stat = await Deno.stat(resolvedInputPath);
    if (!stat.isFile) {
      throw new Error("Input path is not a file");
    }
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      console.error(`Input file not found: ${inputPath}`);
    } else {
      console.error(`Cannot read input file '${inputPath}': ${error}`);
    }
    Deno.exit(1);
  }

  if (!inputPath.endsWith(".trip")) {
    console.error(`Input file must have .trip extension: ${inputPath}`);
    Deno.exit(1);
  }

  const resolvedOutputPath = outputPath ? resolve(outputPath) : undefined;

  await compileFile(resolvedInputPath, resolvedOutputPath, options.verbose);
}

if (import.meta.main) {
  await main();
}
