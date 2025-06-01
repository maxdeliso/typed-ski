import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export function loadInput(filename: string, dirname: string): string {
  const filePath = resolve(dirname, "inputs", filename);
  return readFileSync(filePath, "utf-8").trim();
}
