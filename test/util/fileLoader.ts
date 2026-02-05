import { resolve } from "node:path";
import { loadTripSourceFileSync } from "../../lib/tripSourceLoader.ts";

export function loadInput(filename: string, dirname: string): string {
  const filePath = resolve(dirname, "inputs", filename);
  return loadTripSourceFileSync(filePath).trim();
}
