import { fromFileUrl } from "std/path";
import type { TripCObject } from "./compiler/objectFile.ts";

type TripSourceLocation = string | URL;

const SOURCE_CACHE = new Map<string, string>();
const MODULE_CACHE = new Map<string, TripCObject>();

function normalizePath(sourceLocation: TripSourceLocation): string {
  if (sourceLocation instanceof URL) {
    return fromFileUrl(sourceLocation);
  }
  return sourceLocation;
}

export async function loadTripSourceFile(
  sourceLocation: TripSourceLocation,
): Promise<string> {
  const filePath = normalizePath(sourceLocation);
  const cached = SOURCE_CACHE.get(filePath);
  if (cached !== undefined) {
    return cached;
  }

  const source = await Deno.readTextFile(filePath);
  SOURCE_CACHE.set(filePath, source);
  return source;
}

export function loadTripSourceFileSync(
  sourceLocation: TripSourceLocation,
): string {
  const filePath = normalizePath(sourceLocation);
  const cached = SOURCE_CACHE.get(filePath);
  if (cached !== undefined) {
    return cached;
  }

  const source = Deno.readTextFileSync(filePath);
  SOURCE_CACHE.set(filePath, source);
  return source;
}

export async function loadTripModuleObject(
  sourceLocation: TripSourceLocation,
): Promise<TripCObject> {
  const filePath = normalizePath(sourceLocation);
  const cached = MODULE_CACHE.get(filePath);
  if (cached !== undefined) {
    return cached;
  }

  const source = await loadTripSourceFile(filePath);
  const [{ compileToObjectFileString }, { deserializeTripCObject }] =
    await Promise.all([
      import("./compiler/index.ts"),
      import("./compiler/objectFile.ts"),
    ]);

  const serialized = compileToObjectFileString(source);
  const object = deserializeTripCObject(serialized);
  MODULE_CACHE.set(filePath, object);
  return object;
}
