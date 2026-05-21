#!/usr/bin/env -S node --disable-warning=ExperimentalWarning

/**
 * TripLang LLVM compiler CLI.
 */

import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  compileTripBundleV1ToLlvm,
  compileTripSourceToLlvm,
  parseLlvmTarget,
  readModuleSourceSpec,
  type LlvmTargetProfile,
} from "../lib/compiler/index.ts";
import { VERSION } from "../lib/shared/version.ts";

interface CLIOptions {
  help: boolean;
  version: boolean;
  verbose: boolean;
  stdout: boolean;
  moduleSources: string[];
  entryModule?: string;
  target: LlvmTargetProfile;
  emitMainWrapper: boolean;
  bundleV1: boolean;
}

function parseArgs(args: string[]): {
  options: CLIOptions;
  inputPath?: string;
  outputPath?: string;
} {
  const options: CLIOptions = {
    help: false,
    version: false,
    verbose: false,
    stdout: false,
    moduleSources: [],
    target: { kind: "generic" },
    emitMainWrapper: false,
    bundleV1: false,
  };

  let inputPath: string | undefined;
  let outputPath: string | undefined;

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
      case "--stdout":
      case "-s":
        options.stdout = true;
        break;
      case "--emit": {
        const value = requireValue(args, ++i, arg);
        if (value !== "llvm") {
          console.error(`Unsupported emit target: ${value}`);
          console.error("Use --emit llvm.");
          process.exit(1);
        }
        break;
      }
      case "--bundle-v1":
        options.bundleV1 = true;
        break;
      case "--module-source":
        options.moduleSources.push(requireValue(args, ++i, arg));
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
      default:
        if (arg.startsWith("-")) {
          console.error(`Unknown option: ${arg}`);
          console.error("Use --help for usage information.");
          process.exit(1);
        }

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
        break;
    }
  }

  return { options, inputPath, outputPath };
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
TripLang LLVM Compiler (tripc) v${VERSION}

USAGE:
    tripc <input.trip> [output.ll]
    tripc --emit llvm <input.trip> [output.ll]
    tripc --bundle-v1 <input.bundle-v1> [output.ll]
    tripc [OPTIONS]

SOURCE INPUT:
    <input.trip>     TripLang source file
    [output.ll]      LLVM IR output path; defaults to input.ll

BUNDLE INPUT:
    --bundle-v1      Treat <input> as a deterministic bundle-v1 source bundle

OPTIONS:
    -h, --help       Show this help message
    -v, --version    Show version information
    -V, --verbose    Enable verbose output
    -s, --stdout     Print LLVM IR to stdout
    --module-source <name=path>
                     Additional source module, repeatable
    --entry-module <name>
                     Entry module name; defaults to the input module declaration
    --target <triple>
                     generic | arm64-apple-darwin | x86_64-unknown-linux-gnu | x86_64-pc-windows-msvc
    --emit-main-wrapper
                     Emit an int main() wrapper that calls the Trip entry

EXAMPLES:
    tripc mymodule.trip mymodule.ll
    tripc --emit llvm mymodule.trip --stdout
    tripc --bundle-v1 compiler.bundle-v1 out.ll
`);
}

function showVersion(): void {
  console.log(`tripc v${VERSION}`);
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

    let llvm: string;
    if (options.bundleV1) {
      if (options.moduleSources.length > 0 || options.entryModule) {
        throw new Error(
          "--bundle-v1 cannot be combined with --module-source or --entry-module",
        );
      }
      llvm = compileTripBundleV1ToLlvm(await readFile(inputPath));
    } else {
      const moduleSources = await Promise.all(
        options.moduleSources.map(readModuleSourceSpec),
      );
      llvm = compileTripSourceToLlvm(await readFile(inputPath, "utf8"), {
        entryModule: options.entryModule,
        moduleSources,
        target: options.target,
        emitMainWrapper: options.emitMainWrapper,
      });
    }

    if (options.stdout) {
      process.stdout.write(llvm + "\n");
      return;
    }

    const finalOutputPath = outputPath || inputPath.replace(/\.[^.]*$/, ".ll");
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
  const { options, inputPath, outputPath } = parseArgs(process.argv.slice(2));

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

  await emitLlvmFile(
    resolvedInputPath,
    outputPath ? resolve(outputPath) : undefined,
    options,
  );
}

function isMain(importMetaUrl: string): boolean {
  if (!process.argv[1]) return false;
  try {
    return (
      realpathSync(process.argv[1]) ===
      realpathSync(fileURLToPath(importMetaUrl))
    );
  } catch {
    return false;
  }
}

if (isMain(import.meta.url)) {
  await main();
}
