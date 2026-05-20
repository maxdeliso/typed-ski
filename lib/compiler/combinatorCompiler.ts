import { join } from "node:path";
import { getAvlObject } from "../avl.ts";
import { getBinObject } from "../bin.ts";
import { linkModules } from "../linker/moduleLinker.ts";
import { getNatObject } from "../nat.ts";
import { parseTripLang } from "../parser/tripLang.ts";
import { getPreludeObject } from "../prelude.ts";
import { sortedStrings } from "../shared/canonical.ts";
import { workspaceRoot } from "../shared/workspaceRoot.ts";
import {
  loadTripModuleObject,
  loadTripSourceFile,
} from "../tripSourceLoader.ts";
import type { TripCObject } from "./objectFile.ts";
import {
  compileToObjectFile,
  SingleFileCompilerError,
} from "./singleFileCompiler.ts";

const lib = (...parts: string[]) => join(workspaceRoot, "lib", ...parts);

const PRELUDE_SOURCE_FILE = lib("prelude.trip");
const NAT_SOURCE_FILE = lib("nat.trip");
const BIN_SOURCE_FILE = lib("bin.trip");
const AVL_SOURCE_FILE = lib("avl.trip");
const LEXER_SOURCE_FILE = lib("compiler", "lexer.trip");
const PARSER_SOURCE_FILE = lib("compiler", "parser.trip");
const CORE_SOURCE_FILE = lib("compiler", "core.trip");
const DATA_ENV_SOURCE_FILE = lib("compiler", "dataEnv.trip");
const CORE_TO_LOWER_SOURCE_FILE = lib("compiler", "coreToLower.trip");
const UNPARSE_SOURCE_FILE = lib("compiler", "unparse.trip");
const LOWERING_SOURCE_FILE = lib("compiler", "lowering.trip");
const BRIDGE_SOURCE_FILE = lib("compiler", "bridge.trip");
const LLVM_SOURCE_FILE = lib("compiler", "llvm.trip");
const BUNDLE_SUMMARY_SOURCE_FILE = lib("compiler", "bundleSummary.trip");
const CORE_TO_MINI_SOURCE_FILE = lib("compiler", "coreToMini.trip");
const MINI_CORE_SOURCE_FILE = lib("compiler", "miniCore.trip");
const ANF_SOURCE_FILE = lib("compiler", "anf.trip");
const COMPILER_SOURCE_FILE = lib("compiler", "index.trip");
const TELEMETRY_SOURCE_FILE = lib("compiler", "telemetry.trip");

interface BuiltinModuleSpec {
  source: string;
  load: () => Promise<TripCObject>;
}

const BUILTIN_MODULES = new Map<string, BuiltinModuleSpec>([
  ["Prelude", { source: PRELUDE_SOURCE_FILE, load: getPreludeObject }],
  ["Nat", { source: NAT_SOURCE_FILE, load: getNatObject }],
  ["Bin", { source: BIN_SOURCE_FILE, load: getBinObject }],
  ["Avl", { source: AVL_SOURCE_FILE, load: getAvlObject }],
  [
    "Lexer",
    {
      source: LEXER_SOURCE_FILE,
      load: () => loadTripModuleObject(LEXER_SOURCE_FILE),
    },
  ],
  [
    "Parser",
    {
      source: PARSER_SOURCE_FILE,
      load: () => loadTripModuleObject(PARSER_SOURCE_FILE),
    },
  ],
  [
    "Core",
    {
      source: CORE_SOURCE_FILE,
      load: () => loadTripModuleObject(CORE_SOURCE_FILE),
    },
  ],
  [
    "DataEnv",
    {
      source: DATA_ENV_SOURCE_FILE,
      load: () => loadTripModuleObject(DATA_ENV_SOURCE_FILE),
    },
  ],
  [
    "CoreToLower",
    {
      source: CORE_TO_LOWER_SOURCE_FILE,
      load: () => loadTripModuleObject(CORE_TO_LOWER_SOURCE_FILE),
    },
  ],
  [
    "Unparse",
    {
      source: UNPARSE_SOURCE_FILE,
      load: () => loadTripModuleObject(UNPARSE_SOURCE_FILE),
    },
  ],
  [
    "Lowering",
    {
      source: LOWERING_SOURCE_FILE,
      load: () => loadTripModuleObject(LOWERING_SOURCE_FILE),
    },
  ],
  [
    "Bridge",
    {
      source: BRIDGE_SOURCE_FILE,
      load: () => loadTripModuleObject(BRIDGE_SOURCE_FILE),
    },
  ],
  [
    "Llvm",
    {
      source: LLVM_SOURCE_FILE,
      load: () => loadTripModuleObject(LLVM_SOURCE_FILE),
    },
  ],
  [
    "BundleSummary",
    {
      source: BUNDLE_SUMMARY_SOURCE_FILE,
      load: () => loadTripModuleObject(BUNDLE_SUMMARY_SOURCE_FILE),
    },
  ],
  [
    "CoreToMini",
    {
      source: CORE_TO_MINI_SOURCE_FILE,
      load: () => loadTripModuleObject(CORE_TO_MINI_SOURCE_FILE),
    },
  ],
  [
    "MiniCore",
    {
      source: MINI_CORE_SOURCE_FILE,
      load: () => loadTripModuleObject(MINI_CORE_SOURCE_FILE),
    },
  ],
  [
    "Anf",
    {
      source: ANF_SOURCE_FILE,
      load: () => loadTripModuleObject(ANF_SOURCE_FILE),
    },
  ],
  [
    "Compiler",
    {
      source: COMPILER_SOURCE_FILE,
      load: () => loadTripModuleObject(COMPILER_SOURCE_FILE),
    },
  ],
  [
    "Telemetry",
    {
      source: TELEMETRY_SOURCE_FILE,
      load: () => loadTripModuleObject(TELEMETRY_SOURCE_FILE),
    },
  ],
]);

function sanitizeImportedModule(
  moduleName: string,
  object: TripCObject,
): TripCObject {
  if (moduleName !== "Compiler") {
    return object;
  }
  const omittedDefinitions = new Set([
    "main",
    "compileToLlvm",
    "compileBundleToLlvm",
    "findModuleSource",
    "writeAll",
  ]);
  return {
    ...object,
    exports: object.exports.filter((name) => !omittedDefinitions.has(name)),
    imports: object.imports.filter(
      (imp) => imp.from !== "Llvm" && imp.from !== "BundleSummary",
    ),
    definitions: Object.fromEntries(
      Object.entries(object.definitions).filter(
        ([name]) => !omittedDefinitions.has(name),
      ),
    ),
  };
}

function importedModuleNames(source: string): string[] {
  const modules = new Set<string>();
  for (const term of parseTripLang(source).terms) {
    if (term.kind === "import") {
      modules.add(term.name);
    }
  }
  return sortedStrings(modules);
}

function supportedModuleNames(): string {
  return sortedStrings(BUILTIN_MODULES.keys()).join(", ");
}

async function loadBuiltinModuleGraph(
  rootModuleNames: ReadonlyArray<string>,
): Promise<Map<string, TripCObject>> {
  const loaded = new Map<string, TripCObject>();
  const visiting = new Set<string>();

  const visit = async (moduleName: string): Promise<void> => {
    if (loaded.has(moduleName) || visiting.has(moduleName)) {
      return;
    }

    const spec = BUILTIN_MODULES.get(moduleName);
    if (!spec) {
      throw new SingleFileCompilerError(
        `Unsupported imported module '${moduleName}'. Supported built-ins: ${supportedModuleNames()}`,
      );
    }

    visiting.add(moduleName);
    try {
      const source = await loadTripSourceFile(spec.source);
      for (const importedModuleName of importedModuleNames(source)) {
        if (
          moduleName === "Compiler" &&
          (importedModuleName === "Llvm" ||
            importedModuleName === "BundleSummary")
        ) {
          continue;
        }
        await visit(importedModuleName);
      }
      loaded.set(
        moduleName,
        sanitizeImportedModule(moduleName, await spec.load()),
      );
    } finally {
      visiting.delete(moduleName);
    }
  };

  for (const rootModuleName of sortedStrings(rootModuleNames)) {
    await visit(rootModuleName);
  }

  return loaded;
}

/**
 * Compiles a TripLang module source string to the final linked combinator string
 * using the TypeScript compiler and built-in library modules.
 */
export async function compileToCombinatorString(
  source: string,
): Promise<string> {
  const directImports = importedModuleNames(source);
  const moduleGraph = await loadBuiltinModuleGraph(directImports);
  const importedModules = directImports.map((moduleName) => {
    const object = moduleGraph.get(moduleName);
    if (!object) {
      throw new SingleFileCompilerError(
        `Failed to load imported module '${moduleName}'.`,
      );
    }
    return object;
  });

  const objectFile = compileToObjectFile(source, { importedModules });
  if (moduleGraph.has(objectFile.module)) {
    throw new SingleFileCompilerError(
      `Source module '${objectFile.module}' conflicts with an imported built-in module of the same name.`,
    );
  }

  const modules = sortedStrings(moduleGraph.keys()).map((moduleName) => ({
    name: moduleName,
    object: moduleGraph.get(moduleName)!,
  }));
  modules.push({ name: objectFile.module, object: objectFile });

  return linkModules(modules);
}
