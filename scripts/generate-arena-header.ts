/**
 * Generate TypeScript constants for SabHeader field indices
 *
 * This script parses the Rust SabHeader struct definition and generates
 * TypeScript constants that match the field order. This ensures the TypeScript
 * code stays in sync with the Rust struct layout.
 *
 * The generated file should be imported and used instead of hardcoded indices.
 */

import { generateFromRustSource } from "../lib/codegen/arenaHeader.ts";
import { parseRustStruct, type StructField } from "../lib/parser/rustStruct.ts";

const rustArenaFile = await Deno.readTextFile("rust/src/arena.rs");
const structName = "SabHeader";

// Generate TypeScript constants
let content: string;
try {
  content = generateFromRustSource(rustArenaFile, structName);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Error generating ${structName} constants: ${message}`);
  Deno.exit(1);
}

// Write generated file
await Deno.writeTextFile("lib/evaluator/arenaHeader.generated.ts", content);

// Parse again to get field count for output
const parsedStruct = parseRustStruct(rustArenaFile, structName);
const fields = parsedStruct.fields.map((f: StructField) => f.name);

console.log(
  `Successfully generated arena header constants with ${fields.length} fields:`,
);
console.log(fields.map((f: string, i: number) => `  ${i}: ${f}`).join("\n"));
