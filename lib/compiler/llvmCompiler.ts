import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  anfToBlockModule,
  compileMiniCoreModules,
  toAnfProgram,
  type MiniCoreModuleSource,
} from "../minicore/index.ts";
import { validateNativeV1Subset } from "../minicore/nativeV1Subset.ts";
import { parseTripLang } from "../parser/tripLang.ts";
import { compareAscii } from "../shared/canonical.ts";
import { parseTripBundleV1 } from "./bundleV1.ts";
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
  validateNativeV1Subset?: boolean;
}

export interface CompileTripModulesToLlvmOptions {
  modules: ReadonlyArray<MiniCoreModuleSource>;
  entryModule: string;
  target?: LlvmTargetProfile;
  representation?: LlvmRepresentation;
  emitMainWrapper?: boolean;
  mainWrapper?: EmitLlvmOptions["mainWrapper"];
  validateNativeV1Subset?: boolean;
}

export interface TripModuleSourceFileSpec {
  name: string;
  path: string;
}

export function parseLlvmTarget(value: string): LlvmTargetProfile {
  switch (value) {
    case "arm64-apple-darwin":
    case "generic":
    case "x86_64-unknown-linux-gnu":
    case "x86_64-pc-windows-msvc":
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

export function compileTripModulesToLlvm(
  options: CompileTripModulesToLlvmOptions,
): string {
  const names = new Set<string>();
  let hasEntry = false;
  for (const module of options.modules) {
    if (names.has(module.name)) {
      throw new Error(`Duplicate module source: ${module.name}`);
    }
    names.add(module.name);
    if (module.name === options.entryModule) {
      hasEntry = true;
    }
  }
  if (!hasEntry) {
    throw new Error(`Entry module ${options.entryModule} is not present`);
  }

  const program = compileMiniCoreModules(
    [...options.modules],
    options.entryModule,
    { requireNullaryEntry: false },
  );

  if (options.validateNativeV1Subset ?? true) {
    validateNativeV1Subset(program);
  }

  const blockModule = anfToBlockModule(toAnfProgram(program));

  return emitLlvmModule(blockModule, {
    target: options.target,
    representation: options.representation ?? "boxed-runtime",
    emitMainWrapper: options.emitMainWrapper,
    mainWrapper: options.mainWrapper,
  });
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

  return compileTripModulesToLlvm({
    modules: [...moduleSources, { name: entryModule, source: inputSource }],
    entryModule,
    target: options.target,
    representation: options.representation,
    emitMainWrapper: options.emitMainWrapper,
    mainWrapper: options.mainWrapper,
    validateNativeV1Subset: options.validateNativeV1Subset,
  });
}

export function compileTripBundleV1ToLlvm(
  bundleSource: Uint8Array,
  options: Omit<
    CompileTripModulesToLlvmOptions,
    "modules" | "entryModule" | "target" | "emitMainWrapper" | "mainWrapper"
  > = {},
): string {
  const bundle = parseTripBundleV1(bundleSource);
  const modules = [...bundle.modules].sort((left, right) =>
    compareAscii(left.name, right.name),
  );
  for (const module of modules) {
    const declaredModule = moduleNameOfTripSource(module.source);
    if (declaredModule !== module.name) {
      throw new Error(
        `Bundle-v1 module ${module.name} source declares module ${declaredModule}`,
      );
    }
  }
  return compileTripModulesToLlvm({
    ...options,
    modules,
    entryModule: bundle.entryModule,
    target: bundle.target,
    mainWrapper: bundle.mainWrapper,
  });
}
