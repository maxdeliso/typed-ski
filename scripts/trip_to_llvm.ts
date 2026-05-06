#!/usr/bin/env -S node --disable-warning=ExperimentalWarning --experimental-transform-types

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  compileTripSourceToLlvm,
  parseLlvmTarget,
  readModuleSourceSpec,
  type LlvmTargetProfile,
} from "../lib/compiler/index.ts";

interface Options {
  input?: string;
  output?: string;
  entryModule?: string;
  moduleSources: string[];
  target: LlvmTargetProfile;
  emitMainWrapper: boolean;
}

function usage(): never {
  console.error(`Usage: trip_to_llvm --input main.trip --output main.ll [options]

Options:
  --entry-module <name>          Entry module name; defaults to the input module declaration
  --module-source <name=path>    Additional source module, repeatable
  --target <triple>              generic | x86_64-unknown-linux-gnu | x86_64-pc-windows-msvc | wasm32-unknown-unknown | wasm32-wasi
  --emit-main-wrapper            Emit an int main() wrapper that calls the Trip entry`);
  process.exit(1);
}

function parseArgs(args: string[]): Options {
  const options: Options = {
    moduleSources: [],
    target: { kind: "generic" },
    emitMainWrapper: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case "--input":
        options.input = requireValue(args, ++i, arg);
        break;
      case "--output":
        options.output = requireValue(args, ++i, arg);
        break;
      case "--entry-module":
        options.entryModule = requireValue(args, ++i, arg);
        break;
      case "--module-source":
        options.moduleSources.push(requireValue(args, ++i, arg));
        break;
      case "--target":
        options.target = parseLlvmTarget(requireValue(args, ++i, arg));
        break;
      case "--emit-main-wrapper":
        options.emitMainWrapper = true;
        break;
      case "--help":
      case "-h":
        usage();
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (!options.input || !options.output) usage();
  return options;
}

function requireValue(args: string[], index: number, option: string): string {
  const value = args[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`${option} requires a value`);
  }
  return value;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const inputPath = resolve(options.input!);
  const outputPath = resolve(options.output!);
  const inputSource = await readFile(inputPath, "utf8");
  const modules = await Promise.all(
    options.moduleSources.map(readModuleSourceSpec),
  );
  const llvm = compileTripSourceToLlvm(inputSource, {
    entryModule: options.entryModule,
    moduleSources: modules,
    target: options.target,
    emitMainWrapper: options.emitMainWrapper,
  });
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, llvm + "\n", "utf8");
}

await main();
