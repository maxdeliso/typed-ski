#!/usr/bin/env -S deno run --allow-read --allow-write

/**
 * TripLang Compiler & Linker CLI (tripc)
 *
 * A unified command-line tool for compiling TripLang modules and linking object files.
 *
 * Compilation Usage:
 *   tripc <input.trip> [output.tripc]
 *   tripc --compile <input.trip> [output.tripc]
 *
 * Linking Usage:
 *   tripc --link <input1.tripc> [input2.tripc] ...
 *   tripc -l <input1.tripc> [input2.tripc] ...
 *
 * General Usage:
 *   tripc --help
 *   tripc --version
 *
 * Examples:
 *   tripc mymodule.trip                    # Compile to mymodule.tripc
 *   tripc --link module1.tripc module2.tripc  # Link modules
 *   tripc --help
 */

import { resolve } from "std/path";
import {
  compileToObjectFileString,
  SingleFileCompilerError,
} from "../lib/compiler/index.ts";
import {
  deserializeTripCObject,
  type TripCObject,
} from "../lib/compiler/objectFile.ts";
import { linkModules } from "../lib/linker/moduleLinker.ts";
import { VERSION } from "../lib/shared/version.ts";
import { getPreludeObject } from "../lib/prelude.ts";

type Mode = "compile" | "link";

interface CLIOptions {
  help: boolean;
  version: boolean;
  verbose: boolean;
  mode: Mode;
}

function parseArgs(
  args: string[],
): {
  options: CLIOptions;
  inputPath?: string;
  outputPath?: string;
  inputFiles?: string[];
} {
  const options: CLIOptions = {
    help: false,
    version: false,
    verbose: false,
    mode: "compile", // Default to compile mode
  };

  let inputPath: string | undefined;
  let outputPath: string | undefined;
  const inputFiles: string[] = [];

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
      case "-V":
        options.verbose = true;
        break;
      case "--compile":
      case "-c":
        options.mode = "compile";
        break;
      case "--link":
      case "-l":
        options.mode = "link";
        break;
      default:
        if (arg.startsWith("-")) {
          console.error(`Unknown option: ${arg}`);
          console.error("Use --help for usage information.");
          Deno.exit(1);
        }

        if (options.mode === "link") {
          inputFiles.push(arg);
        } else {
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
        }
        break;
    }
  }

  return { options, inputPath, outputPath, inputFiles };
}

function showHelp(): void {
  console.log(`
TripLang Compiler & Linker (tripc) v${VERSION}

USAGE:
    tripc <input.trip> [output.tripc]           # Compile mode (default)
    tripc --compile <input.trip> [output.tripc]  # Explicit compile mode
    tripc --link <input1.tripc> [input2.tripc]... # Link mode
    tripc -l <input1.tripc> [input2.tripc]...    # Short link mode
    tripc [OPTIONS]

COMPILATION MODE:
    <input.trip>     Input TripLang source file
    [output.tripc]   Output object file (optional, defaults to input.tripc)

LINKING MODE:
    <input1.tripc>   First object file to link
    [input2.tripc]   Additional object files to link

OPTIONS:
    -h, --help       Show this help message
    -v, --version    Show version information
    -V, --verbose    Enable verbose output
    -c, --compile    Compile mode (default)
    -l, --link       Link mode

EXAMPLES:
    tripc mymodule.trip                           # Compile to mymodule.tripc
    tripc --link module1.tripc module2.tripc      # Link modules
    tripc --help
    tripc --version

DESCRIPTION:
    Unified compiler and linker for TripLang modules.

    COMPILATION: Compiles a single TripLang module (.trip) into a standardized object file (.tripc).
    The object file contains:
    - Module name and metadata
    - Import/export declarations
    - Elaborated definitions ready for linking
`);
}

function showVersion(): void {
  console.log(`tripc v${VERSION}`);
}

async function validateInputFiles(inputFiles: string[]): Promise<string[]> {
  const validatedFiles: string[] = [];

  for (const file of inputFiles) {
    // Check if file exists
    try {
      await Deno.stat(file);
    } catch {
      throw new Error(`Input file does not exist: ${file}`);
    }

    // Check if file has .tripc extension
    if (!file.endsWith(".tripc")) {
      throw new Error(`Input file must have .tripc extension: ${file}`);
    }

    validatedFiles.push(file);
  }

  return validatedFiles;
}

async function linkFiles(inputFiles: string[], verbose = false): Promise<void> {
  if (verbose) {
    console.log(
      `Linking ${inputFiles.length} files: ${inputFiles.join(", ")}`,
    );
  }

  // Load all .tripc files
  const modules: Array<{ name: string; object: TripCObject }> = [];

  // Always include prelude first (mandatory) - embedded constant
  try {
    if (verbose) {
      console.log("Loading embedded prelude...");
    }
    const preludeObject = await getPreludeObject();
    modules.push({ name: "Prelude", object: preludeObject });
  } catch (error) {
    if (error instanceof SingleFileCompilerError) {
      console.error(`Error compiling embedded prelude: ${error.message}`);
      Deno.exit(1);
    }
    throw error;
  }

  for (const file of inputFiles) {
    if (verbose) {
      console.log(`Loading ${file}...`);
    }

    const content = await Deno.readTextFile(file);
    const object = deserializeTripCObject(content);

    // Use the module name from the file's content
    const moduleName = object.module;

    modules.push({ name: moduleName, object });
  }

  if (verbose) {
    console.log("Linking modules...");
  }

  const result = linkModules(modules, verbose);
  console.log(result);
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
  const { options, inputPath, outputPath, inputFiles } = parseArgs(args);

  if (options.help) {
    showHelp();
    return;
  }

  if (options.version) {
    showVersion();
    return;
  }

  try {
    if (options.mode === "link") {
      if (!inputFiles || inputFiles.length === 0) {
        console.error("Error: No input files specified for linking.");
        console.error("Use --help for usage information.");
        Deno.exit(1);
      }

      const validatedFiles = await validateInputFiles(inputFiles);
      await linkFiles(validatedFiles, options.verbose);
    } else {
      // Compile mode
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
  } catch (error) {
    console.error(
      `Error: ${error instanceof Error ? error.message : String(error)}`,
    );
    Deno.exit(1);
  }
}

if (import.meta.main) {
  await main();
}
