import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareRelease } from "./release_helpers.mjs";

const args = process.argv.slice(2).filter((arg) => arg !== "--");
const stageOnly = args.length === 1 && args[0] === "--stage-only";
if (!stageOnly && (args.length !== 1 || args[0].startsWith("--"))) {
  console.error(
    "Usage: node scripts/release_prepare.js <version> | --stage-only",
  );
  process.exit(1);
}

try {
  prepareRelease({
    root: resolve(dirname(fileURLToPath(import.meta.url)), ".."),
    version: stageOnly ? undefined : args[0],
    stageOnly,
  });
  console.log("Release artifacts are complete and version-consistent.");
} catch (error) {
  console.error(`Release preparation failed: ${error.message}`);
  process.exit(1);
}
