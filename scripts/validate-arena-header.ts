/**
 * Validate that the generated arena header constants match the Rust struct
 *
 * This script checks that:
 * 1. The generated TypeScript file exists
 * 2. The field count matches
 * 3. The field names match (in order)
 *
 * Run this as part of the build process to catch mismatches early.
 */

import { validateArenaHeader } from "../lib/codegen/arenaHeader.ts";

const rustArenaFile = await Deno.readTextFile("rust/src/arena.rs");
const generatedFile = await Deno.readTextFile(
  "lib/evaluator/arenaHeader.generated.ts",
);
const structName = "SabHeader";

// Validate using library function
const result = validateArenaHeader(rustArenaFile, generatedFile, structName);

if (!result.valid) {
  console.error("❌ Validation failed:");
  for (const error of result.errors) {
    console.error(`   ${error}`);
  }
  console.error(
    "\n❌ Run 'deno run -A scripts/generate-arena-header.ts' to regenerate.",
  );
  Deno.exit(1);
}

console.log("✅ Arena header validation passed");
console.log(
  `   ${result.fieldCount} fields match between Rust and TypeScript`,
);
