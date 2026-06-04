#!/usr/bin/env -S node --disable-warning=ExperimentalWarning

/**
 * Orchestrates the full set of improvize maintenance commands against the
 * bootstrap corpus, in the recommended order:
 *
 *   1. prune  — remove unreachable definitions/imports (from known entry points)
 *   2. lint   — apply safe automatic fixes (including do-introduction etc.)
 *   3. format — canonical pretty-print
 *
 * After the three steps it "tests it out" by verifying the corpus is now clean
 * (format --check + lint with no diagnostics and exit code 0).
 *
 * This script is intended to be run via:
 *   pnpm run bootstrap
 *
 * (The pnpm wrapper ensures a fresh build:ts first.)
 *
 * The prune entry points match the ones used by `bootstrap:prune` in package.json.
 */

import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
// When executed from ts_out/scripts/bootstrap.js, __dirname is .../ts_out/scripts
// Project root is two levels up.
const PROJECT_ROOT = join(__dirname, "..", "..");

const IMPROVIZE_BIN = join(PROJECT_ROOT, "ts_out", "bin", "improvize.js");
const NODE = process.execPath;
const NODE_BASE_ARGS = ["--disable-warning=ExperimentalWarning", IMPROVIZE_BIN];

const BOOTSTRAP_SRC = "bootstrap/src";

// Must stay in sync with the entry list in package.json "bootstrap:prune"
const PRUNE_ENTRY_POINTS =
  "Compiler.main,MiniVerify.verifyToAnfText,BundleSummary.main,BundleParseSummary.main,BundleInventory.main,ModuleEnv.main,Llvm.compileSourceToLlvm,AnfLlvm.compileSourceToLlvmText,Llvm.compileBundleSummaryToLlvm";

function runImprovize(args: string[]): void {
  const fullArgs = [...NODE_BASE_ARGS, ...args];
  console.log(`\n> node ${fullArgs.join(" ")}`);
  const result = spawnSync(NODE, fullArgs, {
    cwd: PROJECT_ROOT,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    console.error(`\nCommand failed with exit code ${result.status}`);
    process.exit(result.status ?? 1);
  }
}

function verifyClean(): void {
  console.log("\n=== Testing it out (post-run verification) ===");

  // 1. format --check must succeed (exit 0) with no changes needed.
  console.log("\nChecking formatting (format --check)...");
  let res = spawnSync(NODE, [...NODE_BASE_ARGS, "format", "--check", BOOTSTRAP_SRC], {
    cwd: PROJECT_ROOT,
    stdio: "inherit",
  });
  if (res.status !== 0) {
    console.error("\n❌ Format check failed — the corpus still needs formatting.");
    process.exit(1);
  }

  // 2. lint (no --fix) must succeed with zero diagnostics (exit 0).
  console.log("\nChecking for lint issues (lint without --fix)...");
  res = spawnSync(NODE, [...NODE_BASE_ARGS, "lint", BOOTSTRAP_SRC], {
    cwd: PROJECT_ROOT,
    stdio: "inherit",
  });
  if (res.status !== 0) {
    console.error("\n❌ Lint reported issues — the corpus is not yet clean.");
    process.exit(1);
  }

  console.log("\n✅ Success! Prune → lint → fmt completed and the bootstrap corpus is clean.");
}

function main(): void {
  console.log("Running improvize bootstrap maintenance (prune → lint → fmt) + verification...");

  runImprovize(["prune", BOOTSTRAP_SRC, PRUNE_ENTRY_POINTS]);
  runImprovize(["lint", "--fix", BOOTSTRAP_SRC]);
  runImprovize(["format", "--write", BOOTSTRAP_SRC]);

  verifyClean();
}

main();
