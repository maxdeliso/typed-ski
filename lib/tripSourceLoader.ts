import { readFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compileToObjectFile } from "./compiler/index.ts";
import type { TripCObject } from "./compiler/objectFile.ts";
import { parseTripLang } from "./parser/tripLang.ts";
import { sortByKey, sortedStrings } from "./shared/canonical.ts";

type TripSourceLocation = string | URL;

const SOURCE_CACHE = new Map<string, string>();
const MODULE_CACHE = new Map<string, TripCObject>();

function normalizePath(sourceLocation: TripSourceLocation): string {
  if (sourceLocation instanceof URL) {
    return fileURLToPath(sourceLocation as any);
  }
  return sourceLocation;
}

export function resetSourceCache(): void {
  SOURCE_CACHE.clear();
  MODULE_CACHE.clear();
}

export async function loadTripSourceFile(
  sourceLocation: TripSourceLocation,
): Promise<string> {
  const filePath = normalizePath(sourceLocation);
  const cached = SOURCE_CACHE.get(filePath);
  if (cached !== undefined) {
    return cached;
  }

  const source = await readFile(filePath, "utf8");
  SOURCE_CACHE.set(filePath, source);
  return source;
}

/** @internal */
export function loadTripSourceFileSync(
  sourceLocation: TripSourceLocation,
): string {
  const filePath = normalizePath(sourceLocation);
  const cached = SOURCE_CACHE.get(filePath);
  if (cached !== undefined) {
    return cached;
  }

  const source = readFileSync(filePath, "utf8");
  SOURCE_CACHE.set(filePath, source);
  return source;
}

function importedModuleNames(source: string): string[] {
  const program = parseTripLang(source);
  const modules = new Set<string>();
  for (const term of program.terms) {
    if (term.kind === "import") {
      modules.add(term.name);
    }
  }
  return sortedStrings(modules);
}

async function resolveImportedModuleSourcePath(
  importerFilePath: string,
  moduleName: string,
): Promise<string | undefined> {
  const parentDir = dirname(importerFilePath);
  const lowerLeading =
    moduleName.length > 0
      ? `${moduleName[0]!.toLowerCase()}${moduleName.slice(1)}`
      : moduleName;
  const candidates = Array.from(
    new Set([
      join(parentDir, `${moduleName}.trip`),
      join(parentDir, `${moduleName.toLowerCase()}.trip`),
      join(parentDir, `${lowerLeading}.trip`),
    ]),
  );

  for (const candidate of candidates) {
    try {
      const stats = await stat(candidate);
      if (stats.isFile()) {
        return candidate;
      }
    } catch {
      // Ignore missing candidate paths.
    }
  }

  return undefined;
}

async function loadTripModuleObjectInternal(
  filePath: string,
  loadingStack: Set<string>,
): Promise<TripCObject> {
  const cached = MODULE_CACHE.get(filePath);
  if (cached !== undefined) {
    return cached;
  }

  const source = await loadTripSourceFile(filePath);
  const importedModules: TripCObject[] = [];

  loadingStack.add(filePath);
  try {
    for (const moduleName of importedModuleNames(source)) {
      const importedSourcePath = await resolveImportedModuleSourcePath(
        filePath,
        moduleName,
      );
      if (!importedSourcePath || loadingStack.has(importedSourcePath)) {
        continue;
      }

      const importedObject = await loadTripModuleObjectInternal(
        importedSourcePath,
        loadingStack,
      );
      importedModules.push(importedObject);
    }
  } finally {
    loadingStack.delete(filePath);
  }

  const object = compileToObjectFile(source, {
    importedModules: sortByKey(
      importedModules,
      (moduleObject) => moduleObject.module,
    ),
  });
  MODULE_CACHE.set(filePath, object);
  return object;
}

export async function loadTripModuleObject(
  sourceLocation: TripSourceLocation,
): Promise<TripCObject> {
  const filePath = normalizePath(sourceLocation);
  return await loadTripModuleObjectInternal(filePath, new Set<string>());
}
