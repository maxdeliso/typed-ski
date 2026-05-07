#!/usr/bin/env -S node --disable-warning=ExperimentalWarning --experimental-transform-types

import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";

import * as process from "node:process";
import { spawn, spawnSync } from "node:child_process";

import {
  assertCurrentNodeVersion,
  getRepoVersion,
  getRequiredNodeVersion,
  PROJECT_ROOT,
} from "./repoNode.ts";

type CommandName =
  | "verify-version"
  | "sync-generated"
  | "verify-generated"
  | "dist"
  | "build"
  | "fmt-check"
  | "lint"
  | "typecheck"
  | "test"
  | "bazel-test-shard";

type AqueryTarget = {
  id: number;
  label: string;
};

type AqueryAction = {
  targetId: number;
  mnemonic: string;
  arguments?: string[];
};

type AqueryResponse = {
  targets?: AqueryTarget[];
  actions?: AqueryAction[];
};

const NODE = process.execPath;
const BAZELISK = process.platform === "win32" ? "bazelisk.exe" : "bazelisk";
const NODE_DISABLE_EXPERIMENTAL_WARNING_ARG =
  "--disable-warning=ExperimentalWarning";
const LOCAL_PNPM_ENTRY = join(
  PROJECT_ROOT,
  "node_modules",
  "pnpm",
  "bin",
  "pnpm.cjs",
);
const LOCAL_TSC_ENTRY = join(
  PROJECT_ROOT,
  "node_modules",
  "typescript",
  "lib",
  "tsc.js",
);
const NODE_TRANSFORM_TYPES_ARG = "--experimental-transform-types";
const NODE_TEST_GLOBAL_SETUP_PATH = join(
  PROJECT_ROOT,
  "test",
  "globalSetup.ts",
);
const TEMP_ROOT =
  process.platform === "win32"
    ? (process.env["LOCALAPPDATA"] ??
      process.env["TEMP"] ??
      process.env["TMP"] ??
      ".")
    : (process.env["TMPDIR"] ?? "/tmp");

const COMPILED_TRIPC_NAME =
  process.platform === "win32" ? "tripc.cmd" : "tripc";
const WASM_BUILD_INPUT_PATHS = [
  join(PROJECT_ROOT, "core"),
  join(PROJECT_ROOT, "wasm"),
  join(PROJECT_ROOT, "bazel"),
  join(PROJECT_ROOT, "BUILD.bazel"),
  join(PROJECT_ROOT, "MODULE.bazel"),
  join(PROJECT_ROOT, ".bazelrc"),
];
const WASM_BUILD_INPUT_EXCLUDES = new Set([
  join(PROJECT_ROOT, "wasm", "release.wasm"),
]);
let ensuredFreshBazelWasmArtifactPromise: Promise<void> | null = null;

function pnpmCommand(...args: string[]): string[] {
  const configuredPnpmPath = process.env["TYPED_SKI_PNPM_PATH"];
  if (configuredPnpmPath) {
    return [NODE, configuredPnpmPath, ...args];
  }
  if (fs.existsSync(LOCAL_PNPM_ENTRY)) {
    return [NODE, LOCAL_PNPM_ENTRY, ...args];
  }
  return ["pnpm", ...args];
}

function esbuildCommand(...args: string[]): string[] {
  return pnpmCommand("dlx", "esbuild@0.28.0", ...args);
}

function splitSpawnArgs(args: string[]): [string, string[]] {
  const [command, ...rest] = args;
  if (!command) {
    throw new Error("Cannot spawn an empty command.");
  }
  return [command, rest];
}

async function ensurePnpmStore(): Promise<string> {
  const storeDir = join(PROJECT_ROOT, ".tmp", "pnpm-store");
  await fsp.mkdir(storeDir, { recursive: true });
  return storeDir;
}
const BAZEL_RELEASE_WASM_FILENAMES = ["release.wasm", "release_wasm.wasm"];
const DIST_REQUIRED_TESTS = new Set(["test/bin/cli.test.ts"]);

const repo = (...parts: string[]) => join(PROJECT_ROOT, ...parts);

type ShardConfig = {
  totalShards: number;
  shardIndex: number;
  statusFilePath?: string;
};

function nodeTestArgs(
  files: string[],
  options: {
    coverage?: boolean;
    extraArgs?: string[];
    coverageReporterDestination?: string;
    rerunFailuresPath?: string;
    shard?: ShardConfig;
    updateSnapshots?: boolean;
  } = {},
): string[] {
  const args = ["--test"];
  args.push("--enable-source-maps");
  args.push("--experimental-test-module-mocks");
  args.push("--test-global-setup", NODE_TEST_GLOBAL_SETUP_PATH);
  args.push("--preserve-symlinks");
  args.push("--test-timeout=60000");

  if (options.coverage) {
    args.push("--experimental-test-coverage");
    args.push("--test-coverage-include=lib/**");
    args.push("--test-coverage-include=compiler/**");
    args.push("--test-coverage-include=bin/**");

    if (options.coverageReporterDestination) {
      const stdoutReporter = process.stdout.isTTY ? "spec" : "tap";
      args.push(`--test-reporter=${stdoutReporter}`);
      args.push("--test-reporter-destination=stdout");
      args.push("--test-reporter=lcov");
      args.push(
        `--test-reporter-destination=${options.coverageReporterDestination}`,
      );
    }
  }
  if (options.rerunFailuresPath) {
    args.push(`--test-rerun-failures=${options.rerunFailuresPath}`);
  }
  if (options.shard) {
    args.push(
      `--test-shard=${options.shard.shardIndex + 1}/${options.shard.totalShards}`,
    );
  }
  if (options.updateSnapshots) {
    args.push("--test-update-snapshots");
  }
  if (options.extraArgs?.length) {
    args.push(...options.extraArgs);
  }
  args.push(...files);
  return args;
}

function usage(): never {
  console.error(`Usage: node --disable-warning=ExperimentalWarning --experimental-transform-types scripts/bazel.ts <command>

Commands:
  verify-version
  sync-generated
  verify-generated
  dist
  build
  fmt-check
  lint
  typecheck
  test
  bazel-test-shard`);
  process.exit(1);
}

function getBazelWasmArtifactCandidates(): string[] {
  const candidates = BAZEL_RELEASE_WASM_FILENAMES.map((filename) =>
    join(PROJECT_ROOT, "bazel-bin", "wasm", filename),
  );

  try {
    if (fs.existsSync(join(PROJECT_ROOT, "bazel-out"))) {
      for (const entry of fs.readdirSync(join(PROJECT_ROOT, "bazel-out"), {
        withFileTypes: true,
      })) {
        if (!entry.isDirectory()) continue;
        for (const filename of BAZEL_RELEASE_WASM_FILENAMES) {
          candidates.push(
            join(
              PROJECT_ROOT,
              "bazel-out",
              entry.name,
              "bin",
              "wasm",
              filename,
            ),
          );
        }
      }
    }
  } catch {}

  return [...new Set(candidates)];
}

async function getLatestModifiedTimeMs(path: string): Promise<number> {
  if (WASM_BUILD_INPUT_EXCLUDES.has(path)) {
    return 0;
  }

  let stat: fs.Stats;
  try {
    stat = await fsp.stat(path);
  } catch {
    return 0;
  }

  if (!stat.isDirectory()) {
    return stat.mtimeMs;
  }

  let latest = stat.mtimeMs;
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(path, { withFileTypes: true });
  } catch {
    return latest;
  }

  for (const entry of entries) {
    const childPath = join(path, entry.name);
    if (entry.isDirectory()) {
      latest = Math.max(latest, await getLatestModifiedTimeMs(childPath));
      continue;
    }
    if (entry.isFile()) {
      latest = Math.max(latest, (await fsp.stat(childPath)).mtimeMs);
      continue;
    }
    if (entry.isSymbolicLink()) {
      latest = Math.max(latest, await getLatestModifiedTimeMs(childPath));
    }
  }

  return latest;
}

async function getLatestWasmInputModifiedTimeMs(): Promise<number> {
  let latest = 0;
  for (const path of WASM_BUILD_INPUT_PATHS) {
    latest = Math.max(latest, await getLatestModifiedTimeMs(path));
  }
  return latest;
}

async function getNewestBazelWasmArtifactModifiedTimeMs(): Promise<number> {
  let newest = 0;
  for (const candidate of getBazelWasmArtifactCandidates()) {
    try {
      const stat = await fsp.stat(candidate);
      if (stat.isFile()) {
        newest = Math.max(newest, stat.mtimeMs);
      }
    } catch {}
  }
  return newest;
}

async function ensureFreshBazelWasmArtifact(): Promise<void> {
  if (ensuredFreshBazelWasmArtifactPromise) {
    await ensuredFreshBazelWasmArtifactPromise;
    return;
  }

  ensuredFreshBazelWasmArtifactPromise = (async () => {
    await syncGenerated();
    const [latestInputMtimeMs, newestArtifactMtimeMs] = await Promise.all([
      getLatestWasmInputModifiedTimeMs(),
      getNewestBazelWasmArtifactModifiedTimeMs(),
    ]);

    if (
      newestArtifactMtimeMs !== 0 &&
      newestArtifactMtimeMs >= latestInputMtimeMs
    ) {
      return;
    }

    console.log(
      newestArtifactMtimeMs === 0
        ? "Building Bazel release_wasm artifact..."
        : "Refreshing stale Bazel release_wasm artifact...",
    );
    await run([BAZELISK, "build", "//:release_wasm"]);
  })();

  try {
    await ensuredFreshBazelWasmArtifactPromise;
  } catch (error) {
    ensuredFreshBazelWasmArtifactPromise = null;
    throw error;
  }
}

async function run(args: string[], options: any = {}): Promise<void> {
  const { env: extraEnv, timeoutMs, ...rest } = options;
  const pnpmStore = await ensurePnpmStore();
  return new Promise((resolve, reject) => {
    const [command, commandArgs] = splitSpawnArgs(args);
    const child = spawn(command, commandArgs, {
      cwd: PROJECT_ROOT,
      stdio: "inherit",
      env: {
        ...process.env,
        pnpm_config_store_dir: pnpmStore,
        ...extraEnv,
      },
      ...rest,
    });

    let didTimeout = false;
    const timeoutId =
      typeof timeoutMs === "number" && timeoutMs > 0
        ? setTimeout(() => {
            didTimeout = true;
            if (process.platform === "win32" && child.pid) {
              spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"]);
            } else {
              child.kill("SIGKILL");
            }
          }, timeoutMs)
        : null;

    child.on("close", (code) => {
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
      }
      if (didTimeout) {
        reject(
          new Error(
            `Command timed out after ${timeoutMs}ms: ${args.join(" ")}`,
          ),
        );
        return;
      }
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(`Command failed with exit code ${code}: ${args.join(" ")}`),
        );
      }
    });

    child.on("error", (err) => {
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
      }
      reject(err);
    });
  });
}

async function runCapture(args: string[], options: any = {}): Promise<string> {
  const { env: extraEnv, ...rest } = options;
  const pnpmStore = await ensurePnpmStore();
  return new Promise((resolve, reject) => {
    const [command, commandArgs] = splitSpawnArgs(args);
    const child = spawn(command, commandArgs, {
      cwd: PROJECT_ROOT,
      stdio: ["ignore", "piped", "inherit"],
      env: {
        ...process.env,
        pnpm_config_store_dir: pnpmStore,
        ...extraEnv,
      },
      ...rest,
    });

    let stdout = "";
    child.stdout!.on("data", (data) => {
      stdout += data.toString();
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(
          new Error(`Command failed with exit code ${code}: ${args.join(" ")}`),
        );
      }
    });

    child.on("error", (err) => {
      reject(err);
    });
  });
}

function verifyVersion(): void {
  const version = getRepoVersion();
  const nodeVersion = getRequiredNodeVersion();
  console.log(`Version in package.json: ${version}`);
  console.log(`Required Node version: ${nodeVersion}`);
}

async function syncGenerated(): Promise<void> {
  if (process.env["BAZEL_TEST"]) {
    console.log("Skipping syncGenerated during Bazel test.");
    return;
  }

  await run([
    NODE,
    NODE_DISABLE_EXPERIMENTAL_WARNING_ARG,
    repo("scripts", "generate_version.mjs"),
    "--package-json",
    repo("package.json"),
    "--ts-out",
    repo("lib", "shared", "version.generated.ts"),
    "--jsr-json",
    repo("jsr.json"),
  ]);
  await run([
    NODE,
    NODE_DISABLE_EXPERIMENTAL_WARNING_ARG,
    repo("scripts", "generate_layouts.mjs"),
    "--input",
    repo("core", "arena_layout.def"),
    "--c-out",
    repo("core", "arena_layout.generated.h"),
    "--ts-out",
    repo("lib", "evaluator", "arenaHeader.generated.ts"),
  ]);
  await run(pnpmCommand("install", "--lockfile-only"));
}

async function verifyGenerated(): Promise<void> {
  await run([
    NODE,
    NODE_DISABLE_EXPERIMENTAL_WARNING_ARG,
    repo("scripts", "generate_version.mjs"),
    "--package-json",
    repo("package.json"),
    "--ts-out",
    repo("lib", "shared", "version.generated.ts"),
    "--jsr-json",
    repo("jsr.json"),
    "--verify",
  ]);
  await run([
    NODE,
    NODE_DISABLE_EXPERIMENTAL_WARNING_ARG,
    repo("scripts", "generate_layouts.mjs"),
    "--input",
    repo("core", "arena_layout.def"),
    "--c-out",
    repo("core", "arena_layout.generated.h"),
    "--ts-out",
    repo("lib", "evaluator", "arenaHeader.generated.ts"),
    "--verify",
  ]);
  console.log("Generated files are up to date.");
}

async function ensurePreconditions(
  options: {
    sync?: boolean;
    freshWasm?: boolean;
    stageWasm?: boolean;
  } = {},
): Promise<void> {
  if (options.sync) {
    await syncGenerated();
  }
  if (options.freshWasm) {
    await ensureFreshBazelWasmArtifact();
  }
  if (options.stageWasm) {
    await stageBazelWasmArtifactIfPresent();
  }
}

async function validateDist(): Promise<void> {
  const requiredFiles = [
    "dist/tripc.js",
    "dist/tripc.min.js",
    "dist/tripc.node.js",
    "dist/arenaWorker.js",
    "dist/arenaWorker.browser.js",
    process.platform === "win32" ? "dist/tripc.cmd" : "dist/tripc",
  ];

  for (const file of requiredFiles) {
    const fullPath = join(PROJECT_ROOT, file);
    if (!fs.existsSync(fullPath)) {
      throw new Error(`Distribution validation failed: Missing ${file}`);
    }
  }

  const wasmPath = join(PROJECT_ROOT, "wasm", "release.wasm");
  if (!fs.existsSync(wasmPath)) {
    console.warn("Warning: wasm/release.wasm is missing from the source tree.");
  }

  console.log("Distribution validation successful.");
}

export async function buildDist(
  options: {
    sync?: boolean;
    freshWasm?: boolean;
    stageWasm?: boolean;
  } = { sync: true, freshWasm: true, stageWasm: true },
): Promise<void> {
  await ensurePreconditions(options);

  await fsp.mkdir(join(PROJECT_ROOT, "dist"), { recursive: true });
  await run(
    esbuildCommand(
      "bin/tripc.ts",
      "--bundle",
      "--outfile=dist/tripc.js",
      "--format=esm",
      "--platform=node",
    ),
  );
  await run(
    esbuildCommand(
      "bin/tripc.ts",
      "--bundle",
      "--minify",
      "--outfile=dist/tripc.min.js",
      "--format=esm",
      "--platform=node",
    ),
  );
  await run(
    esbuildCommand(
      "bin/tripc.ts",
      "--bundle",
      "--outfile=dist/tripc.node.js",
      "--format=esm",
      "--platform=node",
    ),
  );
  await run(
    esbuildCommand(
      "lib/evaluator/arenaWorker.ts",
      "--bundle",
      "--outfile=dist/arenaWorker.js",
      "--format=esm",
      "--platform=node",
    ),
  );
  await run(
    esbuildCommand(
      "lib/evaluator/arenaWorker.ts",
      "--bundle",
      "--outfile=dist/arenaWorker.browser.js",
      "--format=esm",
      "--platform=browser",
      "--external:node:*",
    ),
  );

  const wrapperPath = join(PROJECT_ROOT, "dist", COMPILED_TRIPC_NAME);
  if (process.platform === "win32") {
    await fsp.writeFile(
      wrapperPath,
      '@echo off\r\nsetlocal\r\nnode "%~dp0tripc.node.js" %*\r\n',
      "utf8",
    );
  } else {
    await fsp.writeFile(
      wrapperPath,
      '#!/usr/bin/env sh\nDIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"\nexec node "$DIR/tripc.node.js" "$@"\n',
      "utf8",
    );
    await fsp.chmod(wrapperPath, 0o755);
  }
  console.log(
    `Created ${COMPILED_TRIPC_NAME} as a Node launcher shim for dist/tripc.node.js.`,
  );

  await validateDist();
}

function getBazelWasmArtifactUrl(): string | undefined {
  for (const candidate of getBazelWasmArtifactCandidates()) {
    try {
      const stat = fs.statSync(candidate);
      if (stat.isFile()) return pathToFileURL(candidate).href;
    } catch {}
  }
  return undefined;
}

async function stageBazelWasmArtifactIfPresent(): Promise<void> {
  const stagedPath = join(PROJECT_ROOT, "wasm", "release.wasm");
  for (const candidate of getBazelWasmArtifactCandidates()) {
    try {
      const stat = await fsp.stat(candidate);
      if (!stat.isFile()) continue;
      await fsp.mkdir(join(PROJECT_ROOT, "wasm"), { recursive: true });
      const bytes = await fsp.readFile(candidate);
      await fsp.rm(stagedPath, { force: true }).catch(() => {});
      await fsp.writeFile(stagedPath, bytes);
      return;
    } catch {}
  }
}

async function formatCheck(): Promise<void> {
  console.log("Format check using pnpm exec prettier --check .");
  await run(pnpmCommand("exec", "prettier", "--check", "."));
}

async function lint(): Promise<void> {
  console.log("Lint using pnpm exec eslint .");
  await run(pnpmCommand("exec", "eslint", "."));
}

async function collectTests(): Promise<string[]> {
  const testRoot = join(PROJECT_ROOT, "test");
  const files: string[] = [];
  console.log(`Collecting tests from ${testRoot}...`);

  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch (err) {
      console.error(`Error reading directory ${dir}: ${err}`);
      return;
    }

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      let isDir = entry.isDirectory();
      let isFile = entry.isFile();

      if (entry.isSymbolicLink()) {
        try {
          const s = await fsp.stat(fullPath);
          isDir = s.isDirectory();
          isFile = s.isFile();
        } catch {
          continue;
        }
      }

      if (isDir) {
        await walk(fullPath);
      } else if (isFile && entry.name.endsWith(".test.ts")) {
        const relPath = relative(PROJECT_ROOT, fullPath).replaceAll("\\", "/");
        files.push(relPath);
      }
    }
  }

  await walk(testRoot);
  files.sort();
  console.log(`Found ${files.length} test files.`);
  if (files.length > 0) {
    console.log(`Sample test paths: ${files.slice(0, 3).join(", ")}`);
  }
  return files;
}

function parseTestArgs(args: string[]): {
  nodeArgs: string[];
  filters: string[];
} {
  const nodeArgs: string[] = [];
  const filters: string[] = [];
  for (const arg of args) {
    const trimmed = arg.trim();
    if (trimmed.length === 0 || trimmed === "--") continue;
    if (trimmed.startsWith("-")) {
      nodeArgs.push(trimmed);
    } else {
      filters.push(trimmed);
    }
  }
  return { nodeArgs, filters };
}

async function typecheckTests(files: string[]): Promise<void> {
  console.log(`Type checking project...`);
  if (!fs.existsSync(LOCAL_TSC_ENTRY)) {
    throw new Error(
      `Local TypeScript compiler not found at ${LOCAL_TSC_ENTRY}. Run pnpm install first.`,
    );
  }
  await run([NODE, LOCAL_TSC_ENTRY, "--noEmit"]);
}

function readShardConfig(): ShardConfig {
  const totalText = process.env["TEST_TOTAL_SHARDS"];
  const indexText = process.env["TEST_SHARD_INDEX"];
  const statusFilePath = process.env["TEST_SHARD_STATUS_FILE"] ?? undefined;

  const totalShards = totalText ? Number(totalText) : 1;
  const shardIndex = indexText ? Number(indexText) : 0;

  if (!Number.isInteger(totalShards) || totalShards <= 0) {
    throw new Error(
      `Invalid TEST_TOTAL_SHARDS value: ${totalText ?? "<unset>"}`,
    );
  }
  if (!Number.isInteger(shardIndex) || shardIndex < 0) {
    throw new Error(
      `Invalid TEST_SHARD_INDEX value: ${indexText ?? "<unset>"}`,
    );
  }
  if (shardIndex >= totalShards) {
    throw new Error(
      `TEST_SHARD_INDEX (${shardIndex}) must be less than TEST_TOTAL_SHARDS (${totalShards})`,
    );
  }

  return { totalShards, shardIndex, statusFilePath };
}

function acknowledgeShardSupport(config: ShardConfig): void {
  if (config.statusFilePath) {
    console.log(`Acknowledging sharding support via ${config.statusFilePath}`);
    fs.writeFileSync(config.statusFilePath, "", "utf8");
  } else {
    console.log("No shard status file path provided by environment.");
  }
}

function needsDistArtifacts(files: string[]): boolean {
  return files.some((file) => DIST_REQUIRED_TESTS.has(file));
}

async function runSelectedTests(
  files: string[],
  env: Record<string, string>,
  options: {
    coverage?: boolean;
    timeoutMs?: number;
    nodeArgs?: string[];
    coverageReporterDestination?: string;
    rerunFailuresPath?: string;
    shard?: ShardConfig;
  } = {},
): Promise<void> {
  if (files.length === 0) {
    console.log("No tests selected.");
    return;
  }

  if (options.coverageReporterDestination) {
    await fsp.mkdir(dirname(options.coverageReporterDestination), {
      recursive: true,
    });
    await fsp
      .rm(options.coverageReporterDestination, { force: true })
      .catch(() => {});
  }

  await run(
    [
      NODE,
      NODE_DISABLE_EXPERIMENTAL_WARNING_ARG,
      NODE_TRANSFORM_TYPES_ARG,
      ...nodeTestArgs(files, {
        coverage: options.coverage,
        extraArgs: options.nodeArgs,
        coverageReporterDestination: options.coverageReporterDestination,
        rerunFailuresPath: options.rerunFailuresPath,
        shard: options.shard,
        updateSnapshots: process.env["TYPED_SKI_UPDATE_SNAPSHOTS"] === "1",
      }),
    ],
    {
      env,
      timeoutMs: options.timeoutMs,
    },
  );
}

async function typecheck(): Promise<void> {
  await syncGenerated();
  const files = await collectTests();
  await typecheckTests(files);
}

async function typecheckAndPrepareTestExecution(
  files: string[],
): Promise<Record<string, string>> {
  await syncGenerated();
  await typecheckTests(files);
  return await prepareTestExecution(files);
}

async function prepareTestExecution(
  files: string[],
): Promise<Record<string, string>> {
  console.log("Preparing test execution environment...");
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("TYPED_SKI_")) {
      console.log(`[env] ${key}: ${process.env[key]}`);
    }
  }
  const explicitWasmPath = process.env["TYPED_SKI_WASM_PATH"];
  if (!explicitWasmPath) {
    await ensureFreshBazelWasmArtifact();
  }
  if (
    needsDistArtifacts(files) &&
    process.env["TYPED_SKI_DIST_READY"] !== "1"
  ) {
    console.log("Building distribution artifacts for tests...");
    await buildDist();
  }

  if (explicitWasmPath) {
    console.log(`Using explicit WASM path: ${explicitWasmPath}`);
    return { TYPED_SKI_WASM_PATH: explicitWasmPath };
  }
  const wasmUrl = getBazelWasmArtifactUrl();
  if (wasmUrl) {
    console.log(`Using detected WASM URL: ${wasmUrl}`);
  } else {
    console.log("No WASM artifact found.");
  }
  return wasmUrl ? { TYPED_SKI_WASM_PATH: wasmUrl } : {};
}

function getBazelCoverageOutputFile(): string | undefined {
  const coverageOutput = process.env["COVERAGE_OUTPUT_FILE"]?.trim();
  return coverageOutput && coverageOutput.length > 0
    ? coverageOutput
    : undefined;
}

export async function runTests(
  withCoverage: boolean,
  args: string[] = [],
): Promise<void> {
  const { nodeArgs, filters } = parseTestArgs(args);
  let files = await collectTests();
  if (filters.length > 0) {
    files = files.filter((f) => filters.some((filter) => f.includes(filter)));
  }

  const env = await typecheckAndPrepareTestExecution(files);

  if (withCoverage) {
    await fsp
      .rm(join(PROJECT_ROOT, "coverage"), { recursive: true, force: true })
      .catch(() => {});
    await runSelectedTests(files, env, { coverage: true, nodeArgs });
    return;
  }

  await runSelectedTests(files, env, { nodeArgs });
}

export async function runBazelShardTests(args: string[] = []): Promise<void> {
  const { nodeArgs, filters } = parseTestArgs(args);
  let files = await collectTests();
  if (filters.length > 0) {
    files = files.filter((f) => filters.some((filter) => f.includes(filter)));
  }

  const shard = readShardConfig();
  acknowledgeShardSupport(shard);
  const coverageReporterDestination = getBazelCoverageOutputFile();

  console.log(
    `[Shard ${shard.shardIndex + 1}/${shard.totalShards}] Executing Node's built-in sharding across ${files.length} test files...`,
  );
  console.log("Skipping test typecheck in shard run; use //:typecheck.");
  const env = await prepareTestExecution(files);
  await runSelectedTests(files, env, {
    coverage: coverageReporterDestination !== undefined,
    nodeArgs,
    coverageReporterDestination,
    shard,
  });
}

async function build(): Promise<void> {
  verifyVersion();
  await buildDist();
}

export async function main(
  argv: string[] = process.argv.slice(2),
): Promise<void> {
  const [command, ...args] = argv;
  if (!command) usage();
  assertCurrentNodeVersion();

  switch (command as CommandName) {
    case "verify-version":
      verifyVersion();
      break;
    case "sync-generated":
      await syncGenerated();
      break;
    case "verify-generated":
      await verifyGenerated();
      break;
    case "dist":
      await buildDist();
      break;
    case "build":
      await build();
      break;
    case "fmt-check":
      await formatCheck();
      break;
    case "lint":
      await lint();
      break;
    case "typecheck":
      await typecheck();
      break;
    case "test":
      await runTests(false, args);
      break;
    case "bazel-test-shard":
      await runBazelShardTests(args);
      break;
    default:
      usage();
  }
}

function isMain(importMetaUrl: string): boolean {
  if (!process.argv[1]) return false;
  try {
    return (
      fs.realpathSync(process.argv[1]) ===
      fs.realpathSync(fileURLToPath(importMetaUrl))
    );
  } catch {
    return false;
  }
}

if (isMain(import.meta.url)) {
  await main();
}
