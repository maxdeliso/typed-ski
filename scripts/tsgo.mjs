import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { availableParallelism } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";

// Thin launcher for the native TypeScript 7 compiler (tsgo, shipped as
// @typescript/native-preview). Its `--checkers` flag caps type-checking
// workers at 4 by default and has no "auto"/"all" value, so we pass the
// machine's full core count explicitly to use every core. All other args pass
// through. availableParallelism() is always >= 1, the minimum --checkers takes.
//
// The package's `exports` map only exposes ./package.json, so we resolve that
// (which is permitted) and derive the bin entry from its directory rather than
// deep-importing bin/tsgo.js directly. The launcher then locates the correct
// per-platform native binary via its own internal #getExePath resolver.
const require = createRequire(import.meta.url);
const packageRoot = dirname(
  require.resolve("@typescript/native-preview/package.json"),
);
const launcher = join(packageRoot, "lib", "tsgo.js");

const checkers = availableParallelism();
const args = ["--checkers", String(checkers), ...process.argv.slice(2)];

const result = spawnSync(process.execPath, [launcher, ...args], {
  stdio: "inherit",
});

if (result.error) {
  throw result.error;
}
process.exit(result.status ?? 1);
