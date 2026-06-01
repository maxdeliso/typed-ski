#!/usr/bin/env -S node --disable-warning=ExperimentalWarning

/**
 * TripLang formatter and linter CLI.
 */

import { readFile, stat, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  discoverTripFiles,
  formatTripSource,
  lintTripSource,
  type TripLintDiagnostic,
} from "../lib/improvize/index.ts";
import { VERSION } from "../lib/shared/version.ts";

type Command = "format" | "lint";

interface ParsedArgs {
  command?: Command;
  help: boolean;
  version: boolean;
  check: boolean;
  write: boolean;
  fix: boolean;
  verbose: boolean;
  paths: string[];
}

function parseArgs(args: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    help: false,
    version: false,
    check: false,
    write: false,
    fix: false,
    verbose: false,
    paths: [],
  };

  for (const arg of args) {
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
      continue;
    }
    if (arg === "--version") {
      parsed.version = true;
      continue;
    }
    if (arg === "--verbose" || arg === "-v") {
      parsed.verbose = true;
      continue;
    }
    if (arg === "--check") {
      parsed.check = true;
      continue;
    }
    if (arg === "--write") {
      parsed.write = true;
      continue;
    }
    if (arg === "--fix") {
      parsed.fix = true;
      continue;
    }
    if (arg === "format" || arg === "lint") {
      if (parsed.command !== undefined) {
        throw new Error(`unexpected extra command: ${arg}`);
      }
      parsed.command = arg;
      continue;
    }
    if (arg.startsWith("-")) {
      throw new Error(`unknown option: ${arg}`);
    }
    parsed.paths.push(arg);
  }

  if (parsed.check && parsed.write) {
    throw new Error("--check cannot be combined with --write");
  }
  if (parsed.command === "format" && parsed.fix) {
    throw new Error("--fix is only valid with lint");
  }
  if (parsed.command === "lint" && (parsed.check || parsed.write)) {
    throw new Error("--check and --write are only valid with format");
  }

  return parsed;
}

function showHelp(): void {
  console.log(`
TripLang formatter and linter (improvize) v${VERSION}

USAGE:
    improvize format [--check|--write] <files-or-dirs...>
    improvize lint [--fix] <files-or-dirs...>

OPTIONS:
    -h, --help       Show this help message
    --version        Show version information
    -v, --verbose    Print timing diagnostics
    --check          Check formatting without writing files
    --write          Rewrite files with formatted output
    --fix            Apply safe lint rewrites, then format
`);
}

function showVersion(): void {
  console.log(`improvize v${VERSION}`);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function collectFiles(paths: string[]): Promise<string[]> {
  if (paths.length === 0) return [];
  for (const path of paths) {
    try {
      await stat(resolve(path));
    } catch {
      throw new Error(`path not found: ${path}`);
    }
  }
  return await discoverTripFiles(paths);
}

async function runFormat(
  paths: string[],
  check: boolean,
  write: boolean,
  verbose: boolean,
) {
  if (paths.length === 0) {
    if (check || write) {
      throw new Error("format --check/--write requires at least one path");
    }
    const input = await readStdin();
    process.stdout.write(formatTripSource(input).formatted);
    return 0;
  }

  const files = await collectFiles(paths);
  if (files.length === 0) {
    return 0;
  }
  if (!check && !write && files.length > 1) {
    throw new Error("formatting multiple files requires --check or --write");
  }

  let changed = false;
  const results = await Promise.all(
    files.map(async (file) => {
      const startFile = Date.now();
      const input = await readFile(file, "utf8");
      const timeRead = Date.now() - startFile;

      const startFormat = Date.now();
      const result = formatTripSource(input);
      const timeFormat = Date.now() - startFormat;

      if (verbose) {
        console.log(
          `[format] ${file}: read in ${timeRead}ms, formatted in ${timeFormat}ms`,
        );
      }

      return { file, result };
    }),
  );

  for (const { file, result } of results) {
    if (!result.changed) {
      if (!write && !check) {
        process.stdout.write(result.formatted);
      }
      continue;
    }
    changed = true;
    if (write) {
      await writeFile(file, result.formatted, "utf8");
      console.log(`${file}: formatted`);
    } else if (check) {
      console.log(`${file}: needs formatting`);
    } else {
      process.stdout.write(result.formatted);
    }
  }

  return changed && check ? 1 : 0;
}

function formatDiagnostic(file: string, diag: TripLintDiagnostic): string {
  return `${file}:${diag.line}:${diag.column}: ${diag.code}: ${diag.message}`;
}

async function runLint(paths: string[], fix: boolean, verbose: boolean) {
  if (paths.length === 0) {
    const input = await readStdin();
    const result = lintTripSource(input, { fix, verbose });
    for (const diag of result.diagnostics) {
      console.log(formatDiagnostic("<stdin>", diag));
    }
    if (fix) {
      process.stdout.write(result.fixed);
      const afterFix = lintTripSource(result.fixed, {
        fix: false,
        verbose,
      });
      return afterFix.diagnostics.length > 0 ? 1 : 0;
    }
    return result.diagnostics.length > 0 ? 1 : 0;
  }

  const files = await collectFiles(paths);
  let hadDiagnostics = false;
  let hadRemainingDiagnostics = false;

  const results = await Promise.all(
    files.map(async (file) => {
      const startFile = Date.now();
      const input = await readFile(file, "utf8");
      const timeRead = Date.now() - startFile;

      const startLint = Date.now();
      const result = lintTripSource(input, { fix, verbose });
      const timeLint = Date.now() - startLint;

      if (verbose) {
        console.log(
          `[lint] ${file}: read in ${timeRead}ms, linted in ${timeLint}ms`,
        );
      }

      let afterFixResult = undefined;
      let timeVerify = 0;
      if (fix) {
        const startSecond = Date.now();
        afterFixResult = lintTripSource(result.changed ? result.fixed : input, {
          fix: false,
          verbose,
        });
        timeVerify = Date.now() - startSecond;
      }

      return { file, input, result, afterFixResult, timeVerify };
    }),
  );

  for (const { file, input, result, afterFixResult, timeVerify } of results) {
    if (result.diagnostics.length > 0) {
      hadDiagnostics = true;
    }
    for (const diag of result.diagnostics) {
      console.log(formatDiagnostic(file, diag));
    }
    if (fix && result.changed) {
      await writeFile(file, result.fixed, "utf8");
      console.log(`${file}: fixed`);
    }
    if (fix && afterFixResult) {
      if (verbose) {
        console.log(`[lint-verify] ${file}: verified in ${timeVerify}ms`);
      }
      if (afterFixResult.diagnostics.length > 0) {
        hadRemainingDiagnostics = true;
      }
    }
  }

  if (fix) {
    return hadRemainingDiagnostics ? 1 : 0;
  }
  return hadDiagnostics ? 1 : 0;
}

async function main(): Promise<void> {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }

  if (parsed.version) {
    showVersion();
    return;
  }
  if (parsed.help || !parsed.command) {
    showHelp();
    return;
  }

  try {
    const status =
      parsed.command === "format"
        ? await runFormat(
            parsed.paths,
            parsed.check,
            parsed.write,
            parsed.verbose,
          )
        : await runLint(parsed.paths, parsed.fix, parsed.verbose);
    process.exit(status);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
}

function isMain(importMetaUrl: string): boolean {
  if (!process.argv[1]) return false;
  try {
    return (
      realpathSync(process.argv[1]) ===
      realpathSync(fileURLToPath(importMetaUrl))
    );
  } catch {
    return false;
  }
}

if (isMain(import.meta.url)) {
  await main();
}
