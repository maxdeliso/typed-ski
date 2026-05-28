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
  validateNativeV1Subset?: boolean;
}

export interface CompileTripModulesToLlvmOptions {
  modules: ReadonlyArray<MiniCoreModuleSource>;
  entryModule: string;
  target?: LlvmTargetProfile;
  representation?: LlvmRepresentation;
  emitMainWrapper?: boolean;
  validateNativeV1Subset?: boolean;
}

export interface TripModuleSourceFileSpec {
  name: string;
  path: string;
}

interface ParsedGraphModule extends MiniCoreModuleSource {
  imports: ReadonlyArray<{ from: string; symbol: string }>;
  exports: ReadonlySet<string>;
}

const BUILTIN_IMPORTS = new Set<string>([
  "Nat.zero",
  "Nat.succ",
  "Nat.add",
  "Nat.mul",
  "Nat.lte",
  "Prelude.Bool",
  "Prelude.false",
  "Prelude.true",
  "Prelude.List",
  "Prelude.nil",
  "Prelude.cons",
  "Prelude.matchList",
  "Prelude.tail",
  "Prelude.reverse",
  "Prelude.fst",
  "Prelude.snd",
  "Prelude.if",
  "Prelude.not",
  "Prelude.and",
  "Prelude.or",
  "Prelude.readOne",
  "Prelude.writeOne",
  "Prelude.eqU8",
  "Prelude.ltU8",
  "Prelude.addU8",
  "Prelude.subU8",
  "Prelude.divU8",
  "Prelude.modU8",
  "Prelude.error",
  "Prelude.U8",
]);

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

function parseGraphModule(module: MiniCoreModuleSource): ParsedGraphModule {
  const program = parseTripLang(module.source);
  const moduleTerms = program.terms.filter((term) => term.kind === "module");
  if (moduleTerms.length === 0) {
    throw new Error(`module ${module.name} source has no module declaration`);
  }
  if (moduleTerms.length > 1) {
    throw new Error(
      `module ${module.name} source has multiple module declarations`,
    );
  }
  const declaredModule = moduleTerms[0]!.name;
  if (declaredModule !== module.name) {
    throw new Error(
      `module ${module.name} source declares module ${declaredModule}`,
    );
  }

  const imports: Array<{ from: string; symbol: string }> = [];
  const exports = new Set<string>();
  for (const term of program.terms) {
    if (term.kind === "import") {
      imports.push({ from: term.name, symbol: term.ref });
    } else if (term.kind === "export") {
      exports.add(term.name);
    }
  }
  imports.sort((left, right) => {
    const byModule = compareAscii(left.from, right.from);
    return byModule === 0 ? compareAscii(left.symbol, right.symbol) : byModule;
  });

  return { ...module, imports, exports };
}

function isBuiltinImport(from: string, symbol: string): boolean {
  return BUILTIN_IMPORTS.has(`${from}.${symbol}`);
}

function resolveEntryModuleGraph(
  modules: ReadonlyArray<MiniCoreModuleSource>,
  entryModule: string,
): MiniCoreModuleSource[] {
  const modulesByName = new Map<string, ParsedGraphModule>();
  for (const module of modules) {
    if (modulesByName.has(module.name)) {
      throw new Error(`Duplicate module source: ${module.name}`);
    }
    modulesByName.set(module.name, parseGraphModule(module));
  }

  if (!modulesByName.has(entryModule)) {
    throw new Error(`Entry module ${entryModule} is not present`);
  }

  const ordered: ParsedGraphModule[] = [];
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const stack: string[] = [];

  const visit = (moduleName: string): void => {
    if (visited.has(moduleName)) {
      return;
    }
    if (visiting.has(moduleName)) {
      const cycleStart = stack.indexOf(moduleName);
      const cycle = [...stack.slice(cycleStart), moduleName].join(" -> ");
      throw new Error(`Import cycle detected: ${cycle}`);
    }

    const module = modulesByName.get(moduleName);
    if (!module) {
      throw new Error(`Missing imported module: ${moduleName}`);
    }

    visiting.add(moduleName);
    stack.push(moduleName);
    for (const imported of module.imports) {
      const dependency = modulesByName.get(imported.from);
      if (!dependency) {
        if (isBuiltinImport(imported.from, imported.symbol)) {
          continue;
        }
        throw new Error(
          `Missing imported module: ${module.name} imports ${imported.from}.${imported.symbol}`,
        );
      }
      if (!dependency.exports.has(imported.symbol)) {
        throw new Error(
          `Imported symbol is not exported: ${module.name} imports ${imported.from}.${imported.symbol}`,
        );
      }
      visit(imported.from);
    }
    stack.pop();
    visiting.delete(moduleName);
    visited.add(moduleName);
    ordered.push(module);
  };

  visit(entryModule);
  return ordered.map(({ name, source }) => ({ name, source }));
}

export function compileTripModulesToLlvm(
  options: CompileTripModulesToLlvmOptions,
): string {
  const modules = resolveEntryModuleGraph(options.modules, options.entryModule);

  const program = compileMiniCoreModules(
    modules,
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
    validateNativeV1Subset: options.validateNativeV1Subset,
  });
}

export function compileTripBundleV1ToLlvm(
  bundleSource: Uint8Array,
  options: Omit<
    CompileTripModulesToLlvmOptions,
    "modules" | "entryModule" | "target" | "emitMainWrapper"
  > = {},
): string {
  const bundle = parseTripBundleV1(bundleSource);
  const modules = [...bundle.modules].sort((left, right) =>
    compareAscii(left.name, right.name),
  );
  return compileTripModulesToLlvm({
    ...options,
    modules,
    entryModule: bundle.entryModule,
    target: bundle.target,
    emitMainWrapper: bundle.emitMainWrapper,
  });
}
