#!/usr/bin/env -S node --disable-warning=ExperimentalWarning --experimental-transform-types

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  anfToBlockModule,
  compileMiniCoreModules,
  toAnfProgram,
  type MiniCoreModuleSource,
} from "../lib/minicore/index.ts";
import {
  emitLlvmModule,
  type LlvmTargetProfile,
} from "../lib/compiler/llvm/index.ts";
import { parseTripLang } from "../lib/parser/tripLang.ts";

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
        options.target = parseTarget(requireValue(args, ++i, arg));
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

function parseTarget(value: string): LlvmTargetProfile {
  switch (value) {
    case "generic":
    case "x86_64-unknown-linux-gnu":
    case "x86_64-pc-windows-msvc":
    case "wasm32-unknown-unknown":
    case "wasm32-wasi":
      return { kind: value };
    default:
      throw new Error(`Unsupported LLVM target: ${value}`);
  }
}

async function readModuleSource(spec: string): Promise<MiniCoreModuleSource> {
  const equals = spec.indexOf("=");
  if (equals <= 0 || equals === spec.length - 1) {
    throw new Error(`Invalid --module-source value: ${spec}`);
  }
  const name = spec.slice(0, equals);
  const path = resolve(spec.slice(equals + 1));
  return { name, source: await readFile(path, "utf8") };
}

function moduleNameOf(source: string): string {
  const moduleTerm = parseTripLang(source).terms.find(
    (term) => term.kind === "module",
  );
  if (!moduleTerm || moduleTerm.kind !== "module") {
    throw new Error("Input Trip source has no module declaration");
  }
  return moduleTerm.name;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const inputPath = resolve(options.input!);
  const outputPath = resolve(options.output!);
  const inputSource = await readFile(inputPath, "utf8");
  const entryModule = options.entryModule ?? moduleNameOf(inputSource);
  const modules = await Promise.all(
    options.moduleSources.map(readModuleSource),
  );

  if (modules.some((module) => module.name === entryModule)) {
    throw new Error(
      `Entry module ${entryModule} was also passed as a module source`,
    );
  }

  const blockModule = anfToBlockModule(
    toAnfProgram(
      compileMiniCoreModules(
        [...modules, { name: entryModule, source: inputSource }],
        entryModule,
      ),
    ),
  );
  const llvm = emitLlvmModule(blockModule, {
    target: options.target,
    emitMainWrapper: options.emitMainWrapper,
  });
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, llvm + "\n", "utf8");
}

await main();
