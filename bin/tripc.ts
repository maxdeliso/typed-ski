#!/usr/bin/env -S node --disable-warning=ExperimentalWarning

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

import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  compileTripBundleV1ToLlvm,
  compileTripSourceToLlvm,
  parseLlvmTarget,
  readModuleSourceSpec,
  SingleFileCompilerError,
  type EmitLlvmOptions,
  type LlvmTargetProfile,
} from "../lib/compiler/index.ts";
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
type EmitKind = "tripc" | "llvm";

interface CLIOptions {
  help: boolean;
  version: boolean;
  verbose: boolean;
  mode: Mode;
  emit: EmitKind;
  stdout: boolean;
  moduleSources: string[];
  entryModule?: string;
  target: LlvmTargetProfile;
  emitMainWrapper: boolean;
  mainWrapper?: EmitLlvmOptions["mainWrapper"];
  bundleV1: boolean;
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
    emit: "tripc",
    stdout: false,
    moduleSources: [],
    target: { kind: "generic" },
    emitMainWrapper: false,
    bundleV1: false,
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
      case "--emit": {
        const value = requireValue(args, ++i, arg);
        if (value !== "tripc" && value !== "llvm") {
          console.error(`Unsupported emit target: ${value}`);
          console.error("Use --emit tripc or --emit llvm.");
          process.exit(1);
        }
        options.emit = value;
        options.mode = "compile";
        break;
      }
      case "--module-source":
        options.moduleSources.push(requireValue(args, ++i, arg));
        break;
      case "--bundle-v1":
        options.bundleV1 = true;
        options.emit = "llvm";
        options.mode = "compile";
        break;
      case "--entry-module":
        options.entryModule = requireValue(args, ++i, arg);
        break;
      case "--target":
        try {
          options.target = parseLlvmTarget(requireValue(args, ++i, arg));
        } catch (error) {
          console.error(error instanceof Error ? error.message : String(error));
          process.exit(1);
        }
        break;
      case "--emit-main-wrapper":
        options.emitMainWrapper = true;
        break;
      case "--main-wrapper": {
        const value = requireValue(args, ++i, arg);
        switch (value) {
          case "none":
            options.mainWrapper = undefined;
            options.emitMainWrapper = false;
            break;
          case "c-main":
            options.mainWrapper = { kind: "c-main" };
            break;
          case "stdin-list-u8":
            options.mainWrapper = { kind: "stdin-list-u8" };
            break;
          default:
            console.error(`Unsupported main wrapper: ${value}`);
            console.error("Use --main-wrapper none|c-main|stdin-list-u8.");
            process.exit(1);
        }
        break;
      }
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

function requireValue(args: string[], index: number, option: string): string {
  const value = args[index];
  if (!value || value.startsWith("--")) {
    console.error(`${option} requires a value`);
    process.exit(1);
  }
  return value;
}

function showHelp(): void {
  console.log(`
TripLang Compiler & Linker (tripc) v${VERSION}

USAGE:
    tripc <input.trip> [output.tripc]           # Compile mode (default)
    tripc --compile <input.trip> [output.tripc]  # Explicit compile mode
    tripc --emit llvm <input.trip> [output.ll]   # Emit LLVM IR
    tripc --link <input1.tripc> [input2.tripc]... # Link mode
    tripc -l <input1.tripc> [input2.tripc]...    # Short link mode
    tripc [OPTIONS]

COMPILATION MODE:
    <input.trip>     Input TripLang source file
    [output.tripc]   Output object file (optional, defaults to input.tripc)

LLVM EMIT MODE:
    --emit llvm      Emit textual LLVM IR instead of a .tripc object file
    --module-source <name=path>
                     Additional source module, repeatable
    --bundle-v1      Treat <input> as a deterministic bundle-v1 source bundle
    --entry-module <name>
                     Entry module name; defaults to the input module declaration
    --target <triple>
                     generic | arm64-apple-darwin | x86_64-unknown-linux-gnu | x86_64-pc-windows-msvc
    --emit-main-wrapper
                     Emit an int main() wrapper that calls the Trip entry
    --main-wrapper <kind>
                     none | c-main | stdin-list-u8

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
    tripc --emit llvm mymodule.trip mymodule.ll   # Emit LLVM IR
    tripc --bundle-v1 compiler.tripbundle out.ll   # Emit LLVM IR from a bundle
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

async function linkFiles(inputFiles: string[]): Promise<void> {
  // Load all .tripc files
  const modules: Array<{ name: string; object: TripCObject }> = [];

  // Always include prelude first (mandatory).
  try {
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
    const content = await readFile(file, "utf8");
    const object = deserializeTripCObject(content);

    // Use the module name from the file's content
    const moduleName = object.module;

    modules.push({ name: moduleName, object });
  }

  const result = linkModules(modules);
  console.log(result);
}

async function compileFile(
  inputPath: string,
  outputPath?: string,
  stdout = false,
): Promise<void> {
  try {
    const objectFile = await loadTripModuleObject(inputPath);
    const serialized = serializeTripCObject(objectFile);

    if (stdout) {
      process.stdout.write(serialized + "\n");
      return;
    }

    const finalOutputPath =
      outputPath || inputPath.replace(/\.trip$/, ".tripc");

    await writeFile(finalOutputPath, serialized, "utf8");
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

async function emitLlvmFile(
  inputPath: string,
  outputPath: string | undefined,
  options: CLIOptions,
): Promise<void> {
  try {
    if (options.verbose) {
      console.log(`Loading ${inputPath}...`);
    }

    if (options.bundleV1) {
      if (options.moduleSources.length > 0 || options.entryModule) {
        throw new Error(
          "--bundle-v1 cannot be combined with --module-source or --entry-module",
        );
      }
      const inputBytes = await readFile(inputPath);
      const llvm = compileTripBundleV1ToLlvm(inputBytes);
      if (options.stdout) {
        process.stdout.write(llvm + "\n");
        return;
      }
      const finalOutputPath =
        outputPath || inputPath.replace(/\.[^.]*$/, ".ll");
      await mkdir(dirname(finalOutputPath), { recursive: true });
      if (options.verbose) {
        console.log(`Writing LLVM IR to ${finalOutputPath}...`);
      }
      await writeFile(finalOutputPath, llvm + "\n", "utf8");
      return;
    }

    const inputSource = await readFile(inputPath, "utf8");

    const moduleSources = await Promise.all(
      options.moduleSources.map(readModuleSourceSpec),
    );

    if (options.verbose) {
      console.log("Lowering TripLang program to LLVM IR...");
    }

    const llvm = compileTripSourceToLlvm(inputSource, {
      entryModule: options.entryModule,
      moduleSources,
      target: options.target,
      emitMainWrapper: options.emitMainWrapper,
      mainWrapper: options.mainWrapper,
    });

    if (options.stdout) {
      process.stdout.write(llvm + "\n");
      return;
    }

    const finalOutputPath = outputPath || inputPath.replace(/\.trip$/, ".ll");

    await mkdir(dirname(finalOutputPath), { recursive: true });

    if (options.verbose) {
      console.log(`Writing LLVM IR to ${finalOutputPath}...`);
    }

    await writeFile(finalOutputPath, llvm + "\n", "utf8");
  } catch (error: any) {
    if (error.code === "ENOENT") {
      console.error(`File not found: ${inputPath}`);
      process.exit(1);
    }
    console.error(
      `LLVM emission error: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
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
      await linkFiles(validatedFiles);
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

      if (!options.bundleV1 && !inputPath.endsWith(".trip")) {
        console.error(`Input file must have .trip extension: ${inputPath}`);
        process.exit(1);
      }

      const resolvedOutputPath = outputPath ? resolve(outputPath) : undefined;
      if (options.emit === "llvm" || options.bundleV1) {
        await emitLlvmFile(resolvedInputPath, resolvedOutputPath, options);
      } else {
        await compileFile(
          resolvedInputPath,
          resolvedOutputPath,
          options.stdout,
        );
      }
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
