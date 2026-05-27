import { linkModules } from "../linker/moduleLinker.ts";
import { parseTripLang } from "../parser/tripLang.ts";
import { sortedStrings } from "../shared/canonical.ts";
import { loadTripSourceFile } from "../tripSourceLoader.ts";
import {
  ALL_COMPILER_TRIP_MODULE_NAMES,
  compilerTripModuleSourcePath,
  isKnownCompilerTripModule,
  loadCompilerTripModule,
} from "./bootstrapModules.ts";
import type { TripCObject } from "./objectFile.ts";
import {
  compileToObjectFile,
  SingleFileCompilerError,
} from "./singleFileCompiler.ts";

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
  return sortedStrings(ALL_COMPILER_TRIP_MODULE_NAMES).join(", ");
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

    if (!isKnownCompilerTripModule(moduleName)) {
      throw new SingleFileCompilerError(
        `Unsupported imported module '${moduleName}'. Supported built-ins: ${supportedModuleNames()}`,
      );
    }

    visiting.add(moduleName);
    try {
      const source = await loadTripSourceFile(
        compilerTripModuleSourcePath(moduleName),
      );
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
        sanitizeImportedModule(
          moduleName,
          await loadCompilerTripModule(moduleName),
        ),
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
