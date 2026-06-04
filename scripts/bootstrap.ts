#!/usr/bin/env -S node --disable-warning=ExperimentalWarning

/**
 * Orchestrates running *all* of improvize's capabilities with their fixing
 * modes against the bootstrap corpus.
 *
 * It runs (in order):
 *   1. prune  (with the standard entry points) — removes unreachable code
 *   2. lint --fix  — applies safe automatic fixes (do-intros, pair sugar, etc.)
 *   3. format --write — canonical pretty-print / layout fixes
 *
 * The goal is that the script makes improvize do everything it's capable of,
 * and *leaves the evidence* in the working tree (the modified .trip files
 * under bootstrap/src/ are the result of the improvements and can be
 * reviewed/committed).
 *
 * After the fixing steps it does a light "test it out" verification
 * (format --check to confirm things are canonical, and a plain lint run
 * to surface any remaining suggestions — these are informational only
 * and do not cause the script to fail or modify anything further).
 *
 * Run via:
 *   pnpm run bootstrap
 *
 * (The pnpm wrapper does a fresh build:ts first.)
 *
 * Prune entry points are kept in sync with the `bootstrap:prune` script
 * in package.json.
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
    // Many improvize subcommands (especially lint --fix) return non-zero when
    // they found suggestions to report or when remaining diagnostics exist after
    // fixes. This is normal and expected; we continue so we can run the full
    // sequence and the final verification.
    console.log(
      `  (exited ${result.status} — often normal for maintenance commands with remaining suggestions)`,
    );
  }
}

function verifyClean(): void {
  console.log("\n=== Testing it out (post-run verification) ===");

  // format --check must succeed (exit 0) — this confirms the fmt step left everything canonical.
  console.log("\nChecking formatting (format --check)...");
  let res = spawnSync(
    NODE,
    [...NODE_BASE_ARGS, "format", "--check", BOOTSTRAP_SRC],
    {
      cwd: PROJECT_ROOT,
      stdio: "inherit",
    },
  );
  if (res.status !== 0) {
    console.error(
      "\n❌ Format check failed — the corpus still needs formatting.",
    );
    process.exit(1);
  }

  // Run lint (no --fix) for informational purposes. The bootstrap corpus often has
  // remaining suggestions (e.g. additional do-introductions, pair sugar, etc.) that
  // are safe improvements but not required to be zero after a single maintenance pass.
  // We do not fail the overall script on them.
  console.log(
    "\nRunning lint (no --fix) to show any remaining suggestions (informational)...",
  );
  res = spawnSync(NODE, [...NODE_BASE_ARGS, "lint", BOOTSTRAP_SRC], {
    cwd: PROJECT_ROOT,
    stdio: "inherit",
  });
  // Note: we ignore the exit code here.

  console.log(
    "\n✅ Success! Prune → lint → fmt completed. Corpus is formatted and lint fixes applied (some suggestions may remain for future passes).",
  );

  // Show the evidence left in the working tree. The script's job is to let
  // improvize perform every fixing action it's capable of; the resulting
  // modifications (or lack thereof) under bootstrap/src/ are the evidence.
  console.log(
    "\nEvidence left in the working tree by improvize (review with `git diff -- bootstrap/src/`):",
  );
  const evidence = spawnSync(
    "git",
    ["status", "--short", "--", BOOTSTRAP_SRC],
    {
      cwd: PROJECT_ROOT,
      encoding: "utf8",
    },
  );
  console.log(
    evidence.stdout?.trim() ||
      "(no further changes — the corpus has had everything improvize can currently auto-apply)",
  );
}

function main(): void {
  console.log(
    "Running improvize bootstrap maintenance (prune → lint → fmt) + verification...",
  );

  runImprovize(["prune", BOOTSTRAP_SRC, PRUNE_ENTRY_POINTS]);
  runImprovize(["lint", "--fix", BOOTSTRAP_SRC]);
  runImprovize(["format", "--write", BOOTSTRAP_SRC]);

  verifyClean();
}

main();
