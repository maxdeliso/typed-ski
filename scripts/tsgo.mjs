import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { availableParallelism } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";

// Thin launcher for the native TypeScript 7 compiler (tsgo, shipped as
// @typescript/native-preview). Its `--checkers` flag caps type-checking
// workers at 4 by default and has no "auto"/"all" value, so we pass the
// machine's full parallelism explicitly (clamped to the >1 minimum tsgo
// requires) to use every available core. All other args pass through.
//
// The package's `exports` map only exposes ./package.json, so we resolve that
// (which is permitted) and derive the bin entry from its directory rather than
// deep-importing bin/tsgo.js directly. The launcher then locates the correct
// per-platform native binary via its own internal #getExePath resolver.
const require = createRequire(import.meta.url);
const packageRoot = dirname(
  require.resolve("@typescript/native-preview/package.json"),
);
const launcher = join(packageRoot, "bin", "tsgo.js");

const checkers = Math.max(2, availableParallelism());
const args = ["--checkers", String(checkers), ...process.argv.slice(2)];

const result = spawnSync(process.execPath, [launcher, ...args], {
  stdio: "inherit",
});

if (result.error) {
  throw result.error;
}
process.exit(result.status ?? 1);
