#!/usr/bin/env -S node --experimental-transform-types

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

import { readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SingleFileCompilerError } from "../lib/compiler/index.ts";
import {
  deserializeTripCObject,
  serializeTripCObject,
  type TripCObject,
} from "../lib/compiler/objectFile.ts";
import { linkModules } from "../lib/linker/moduleLinker.ts";
import { VERSION } from "../lib/shared/version.ts";
import { getPreludeObject } from "../lib/prelude.ts";
import { loadTripModuleObject } from "../lib/tripSourceLoader.ts";

type Mode = "compile" | "link";

interface CLIOptions {
  help: boolean;
  version: boolean;
  verbose: boolean;
  mode: Mode;
  stdout: boolean;
}

function parseArgs(args: string[]): {
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
    stdout: false,
  };

  let inputPath: string | undefined;
  let outputPath: string | undefined;
  const inputFiles: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (!arg) continue;

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
      case "--stdout":
      case "-s":
        options.stdout = true;
        break;
      default:
        if (arg.startsWith("-")) {
          console.error(`Unknown option: ${arg}`);
          console.error("Use --help for usage information.");
          process.exit(1);
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
            process.exit(1);
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
    -s, --stdout     Print compiled output to stdout

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
      await stat(file);
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
    console.log(`Linking ${inputFiles.length} files: ${inputFiles.join(", ")}`);
  }

  // Load all .tripc files
  const modules: Array<{ name: string; object: TripCObject }> = [];

  // Always include prelude first (mandatory).
  try {
    if (verbose) {
      console.log("Loading prelude module...");
    }
    const preludeObject = await getPreludeObject();
    modules.push({ name: "Prelude", object: preludeObject });
  } catch (error) {
    if (error instanceof SingleFileCompilerError) {
      console.error(`Error compiling prelude module: ${error.message}`);
      process.exit(1);
    }
    throw error;
  }

  for (const file of inputFiles) {
    if (verbose) {
      console.log(`Loading ${file}...`);
    }

    const content = await readFile(file, "utf8");
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
  stdout = false,
): Promise<void> {
  try {
    if (verbose) {
      console.log(`Loading ${inputPath}...`);
    }

    if (verbose) {
      console.log("Compiling TripLang program...");
    }

    const objectFile = await loadTripModuleObject(inputPath);
    const serialized = serializeTripCObject(objectFile);

    if (stdout) {
      process.stdout.write(serialized + "\n");
      return;
    }

    const finalOutputPath =
      outputPath || inputPath.replace(/\.trip$/, ".tripc");

    if (verbose) {
      console.log(`Writing object file to ${finalOutputPath}...`);
    }

    await writeFile(finalOutputPath, serialized, "utf8");

    if (verbose) {
      console.log(`   Module: ${objectFile.module}`);
      console.log(`   Imports: ${objectFile.imports.length}`);
      console.log(`   Exports: ${objectFile.exports.length}`);
      console.log(
        `   Definitions: ${Object.keys(objectFile.definitions).length}`,
      );
      console.log(`   Output: ${finalOutputPath}`);
    }
  } catch (error: any) {
    if (error instanceof SingleFileCompilerError) {
      console.error(`Compilation error: ${error.message}`);
      process.exit(1);
    } else if (error.code === "ENOENT") {
      console.error(`File not found: ${inputPath}`);
      process.exit(1);
    } else if (error.code === "EACCES") {
      console.error(`Permission denied: ${error.message}`);
      process.exit(1);
    } else {
      console.error(`Compilation error: ${String(error)}`);
      process.exit(1);
    }
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
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
        process.exit(1);
      }

      const validatedFiles = await validateInputFiles(inputFiles);
      await linkFiles(validatedFiles, options.verbose);
    } else {
      // Compile mode
      if (!inputPath) {
        console.error("Error: No input file specified.");
        console.error("Use --help for usage information.");
        process.exit(1);
      }

      const resolvedInputPath = resolve(inputPath);

      try {
        const stats = await stat(resolvedInputPath);
        if (!stats.isFile()) {
          throw new Error("Input path is not a file");
        }
      } catch (error: any) {
        if (error.code === "ENOENT") {
          console.error(`Input file not found: ${inputPath}`);
        } else {
          console.error(`Cannot read input file '${inputPath}': ${error}`);
        }
        process.exit(1);
      }

      if (!inputPath.endsWith(".trip")) {
        console.error(`Input file must have .trip extension: ${inputPath}`);
        process.exit(1);
      }

      const resolvedOutputPath = outputPath ? resolve(outputPath) : undefined;
      await compileFile(
        resolvedInputPath,
        resolvedOutputPath,
        options.verbose,
        options.stdout,
      );
    }
  } catch (error) {
    console.error(
      `Error: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}

if ((import.meta as any).main) {
  await main();
}
