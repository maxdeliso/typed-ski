import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  anfToBlockModule,
  compileMiniCoreModules,
  toAnfProgram,
  type MiniCoreModuleSource,
} from "../minicore/index.ts";
import { parseTripLang } from "../parser/tripLang.ts";
import {
  emitLlvmModule,
  type EmitLlvmOptions,
  type LlvmRepresentation,
  type LlvmTargetProfile,
} from "./llvm/index.ts";

export interface CompileTripSourceToLlvmOptions {
  entryModule?: string;
  moduleSources?: ReadonlyArray<MiniCoreModuleSource>;
  target?: LlvmTargetProfile;
  representation?: LlvmRepresentation;
  emitMainWrapper?: boolean;
  mainWrapper?: EmitLlvmOptions["mainWrapper"];
}

export interface TripModuleSourceFileSpec {
  name: string;
  path: string;
}

export function parseLlvmTarget(value: string): LlvmTargetProfile {
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

export function moduleNameOfTripSource(source: string): string {
  const moduleTerm = parseTripLang(source).terms.find(
    (term) => term.kind === "module",
  );
  if (!moduleTerm || moduleTerm.kind !== "module") {
    throw new Error("Input Trip source has no module declaration");
  }
  return moduleTerm.name;
}

export function parseModuleSourceSpec(spec: string): TripModuleSourceFileSpec {
  const equals = spec.indexOf("=");
  if (equals <= 0 || equals === spec.length - 1) {
    throw new Error(`Invalid --module-source value: ${spec}`);
  }
  return {
    name: spec.slice(0, equals),
    path: resolve(spec.slice(equals + 1)),
  };
}

export async function readModuleSourceSpec(
  spec: string,
): Promise<MiniCoreModuleSource> {
  const parsed = parseModuleSourceSpec(spec);
  return { name: parsed.name, source: await readFile(parsed.path, "utf8") };
}

export function compileTripSourceToLlvm(
  inputSource: string,
  options: CompileTripSourceToLlvmOptions = {},
): string {
  const entryModule =
    options.entryModule ?? moduleNameOfTripSource(inputSource);
  const moduleSources = options.moduleSources ?? [];

  if (moduleSources.some((module) => module.name === entryModule)) {
    throw new Error(
      `Entry module ${entryModule} was also passed as a module source`,
    );
  }

  const blockModule = anfToBlockModule(
    toAnfProgram(
      compileMiniCoreModules(
        [...moduleSources, { name: entryModule, source: inputSource }],
        entryModule,
        { requireNullaryEntry: false },
      ),
    ),
  );

  return emitLlvmModule(blockModule, {
    target: options.target,
    representation: options.representation ?? "boxed-runtime",
    emitMainWrapper: options.emitMainWrapper,
    mainWrapper: options.mainWrapper,
  });
}
