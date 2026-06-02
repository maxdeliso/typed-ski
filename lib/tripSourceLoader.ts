import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

type TripSourceLocation = string | URL;

const SOURCE_CACHE = new Map<string, string>();

function normalizePath(sourceLocation: TripSourceLocation): string {
  if (sourceLocation instanceof URL) {
    return fileURLToPath(sourceLocation as any);
  }
  return sourceLocation;
}

export function resetSourceCache(): void {
  SOURCE_CACHE.clear();
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
