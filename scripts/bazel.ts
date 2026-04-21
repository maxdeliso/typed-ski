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
  | "hephaestus-assets"
  | "serve-hephaestus"
  | "fmt-check"
  | "lint"
  | "typecheck"
  | "test"
  | "bazel-test-shard"
  | "vs-project";

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
const NPM = process.platform === "win32" ? "npm.cmd" : "npm";
const NPX = process.platform === "win32" ? "npx.cmd" : "npx";
const BAZELISK = process.platform === "win32" ? "bazelisk.exe" : "bazelisk";
const NODE_DISABLE_EXPERIMENTAL_WARNING_ARG =
  "--disable-warning=ExperimentalWarning";
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

async function ensureNpmCache(): Promise<string> {
  const cacheDir = join(PROJECT_ROOT, ".tmp", "npm-cache");
  await fsp.mkdir(cacheDir, { recursive: true });
  return cacheDir;
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
  hephaestus-assets
  serve-hephaestus
  fmt-check
  lint
  typecheck
  test
  bazel-test-shard
  vs-project`);
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
  const npmCache = await ensureNpmCache();
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.platform === "win32" && args[0]!.includes(" ")
        ? `"${args[0]!}"`
        : args[0]!,
      args.slice(1),
      {
        cwd: PROJECT_ROOT,
        stdio: "inherit",
        shell: process.platform === "win32",
        env: {
          ...process.env,
          npm_config_cache: npmCache,
          ...extraEnv,
        },
        ...rest,
      },
    );

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
  const npmCache = await ensureNpmCache();
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.platform === "win32" && args[0]!.includes(" ")
        ? `"${args[0]!}"`
        : args[0]!,
      args.slice(1),
      {
        cwd: PROJECT_ROOT,
        stdio: ["ignore", "piped", "inherit"],
        shell: process.platform === "win32",
        env: {
          ...process.env,
          npm_config_cache: npmCache,
          ...extraEnv,
        },
        ...rest,
      },
    );

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
  await run([
    NODE,
    NODE_DISABLE_EXPERIMENTAL_WARNING_ARG,
    repo("scripts", "generate_version.mjs"),
    "--package-json",
    repo("package.json"),
    "--ts-out",
    repo("lib", "shared", "version.generated.ts"),
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
  await run([NPX, "--yes", "pnpm", "install", "--lockfile-only"]);
  await run([NPM, "install", "--package-lock-only"]);
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

export async function buildDist(): Promise<void> {
  await fsp.mkdir(join(PROJECT_ROOT, "dist"), { recursive: true });
  await run([
    NPX,
    "--yes",
    "esbuild",
    "bin/tripc.ts",
    "--bundle",
    "--outfile=dist/tripc.js",
    "--format=esm",
    "--platform=node",
  ]);
  await run([
    NPX,
    "--yes",
    "esbuild",
    "bin/tripc.ts",
    "--bundle",
    "--minify",
    "--outfile=dist/tripc.min.js",
    "--format=esm",
    "--platform=node",
  ]);
  await run([
    NPX,
    "--yes",
    "esbuild",
    "bin/tripc.ts",
    "--bundle",
    "--outfile=dist/tripc.node.js",
    "--format=esm",
    "--platform=node",
  ]);
  await run([
    NPX,
    "--yes",
    "esbuild",
    "lib/evaluator/arenaWorker.ts",
    "--bundle",
    "--outfile=dist/arenaWorker.js",
    "--format=esm",
    "--platform=node",
  ]);

  const compileTempDir =
    process.env["TYPED_SKI_BUILD_TEMP_DIR"] ??
    join(TEMP_ROOT, "typed-ski-build");
  await fsp.mkdir(compileTempDir, { recursive: true });
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
  console.warn(
    `Created ${COMPILED_TRIPC_NAME} as a Node launcher shim for dist/tripc.node.js.`,
  );
}

async function buildHephaestusAssets(): Promise<void> {
  await syncGenerated();
  await ensureFreshBazelWasmArtifact();
  await stageBazelWasmArtifactIfPresent();
  await fsp.mkdir(join(PROJECT_ROOT, "dist"), { recursive: true });
  await run([
    NPX,
    "--yes",
    "esbuild",
    "server/workbench.js",
    "--bundle",
    "--outfile=dist/workbench.js",
    "--format=esm",
    "--platform=browser",
  ]);
  await run([
    NPX,
    "--yes",
    "esbuild",
    "server/webglForest.ts",
    "--bundle",
    "--outfile=dist/webglForest.js",
    "--format=esm",
    "--platform=browser",
  ]);
  await run([
    NPX,
    "--yes",
    "esbuild",
    "lib/evaluator/arenaWorker.ts",
    "--bundle",
    "--outfile=dist/arenaWorker.js",
    "--format=esm",
    "--platform=browser",
  ]);
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

async function serveHephaestus(): Promise<void> {
  await buildHephaestusAssets();
  const port = process.env["PORT"] ?? "8080";
  await run([
    NODE,
    NODE_DISABLE_EXPERIMENTAL_WARNING_ARG,
    NODE_TRANSFORM_TYPES_ARG,
    "server/serveWorkbench.ts",
    port,
  ]);
}

async function formatCheck(): Promise<void> {
  console.log("Format check using npx prettier --check .");
  await run([NPX, "--yes", "prettier", "--check", "."]);
}

async function lint(): Promise<void> {
  console.log("Lint using npx eslint .");
  await run([NPX, "--yes", "eslint", "."]);
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

function readNodeTestArgs(args: string[]): string[] {
  return args
    .map((arg) => arg.trim())
    .filter((arg) => arg.length > 0 && arg !== "--" && arg.startsWith("-"));
}

async function typecheckTests(files: string[]): Promise<void> {
  console.log(`Type checking project...`);
  if (!fs.existsSync(LOCAL_TSC_ENTRY)) {
    throw new Error(
      `Local TypeScript compiler not found at ${LOCAL_TSC_ENTRY}. Run ${NPM} install first.`,
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
  const files = await collectTests();
  const env = await typecheckAndPrepareTestExecution(files);
  const nodeArgs = readNodeTestArgs(args);

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
  const files = await collectTests();
  const shard = readShardConfig();
  acknowledgeShardSupport(shard);
  const nodeArgs = readNodeTestArgs(args);
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
  await syncGenerated();
  await ensureFreshBazelWasmArtifact();
  await stageBazelWasmArtifactIfPresent();
  await buildDist();
}

function escapeForJsonPath(value: string): string {
  return value.replaceAll("/", "\\\\");
}

function toWorkspaceOrAbsolutePath(path: string): string {
  const rel = relative(PROJECT_ROOT, path);
  if (!rel.startsWith("..") && rel !== "") {
    return "\\${workspaceRoot}\\\\" + escapeForJsonPath(rel);
  }
  if (path === PROJECT_ROOT) {
    return "\\${workspaceRoot}";
  }
  return escapeForJsonPath(path);
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

function quoteCommandArgument(value: string): string {
  if (value.length === 0) return '""';
  if (!/[ "\t]/.test(value)) return value;
  return `"${value.replaceAll('"', '\\"')}"`;
}

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function renderPositionalTemplate(template: string, values: string[]): string {
  return template.replaceAll(/@(\d+)@/g, (match, indexText) => {
    const index = Number(indexText);
    const value = values[index];
    if (value === undefined) {
      throw new Error(`Missing template value for placeholder ${match}`);
    }
    return value;
  });
}

async function collectCoreFiles(): Promise<{
  sources: string[];
  headers: string[];
}> {
  const coreDir = join(PROJECT_ROOT, "core");
  const sources: string[] = [];
  const headers: string[] = [];

  const entries = await fsp.readdir(coreDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (entry.name.endsWith(".c")) {
      sources.push(`core\\\\${entry.name}`);
    } else if (entry.name.endsWith(".h")) {
      headers.push(`core\\\\${entry.name}`);
    }
  }

  sources.sort();
  headers.sort();
  return { sources, headers };
}

type VisualStudioNativeTarget = {
  bazelLabel: string;
  projectName: string;
  projectFileBase: string;
  outputName: string;
  sourceFiles: string[];
  debuggerArgs?: string;
};

const VISUAL_STUDIO_NATIVE_TARGETS: VisualStudioNativeTarget[] = [
  {
    bazelLabel: "//:thanatos",
    projectName: "typed-ski-thanatos",
    projectFileBase: "typed-ski-thanatos",
    outputName: "thanatos.exe",
    sourceFiles: [
      "core\\\\arena.c",
      "core\\\\host_platform_windows.c",
      "core\\\\main.c",
      "core\\\\session.c",
      "core\\\\ski_io.c",
      "core\\\\thanatos.c",
      "core\\\\util.c",
    ],
  },
  {
    bazelLabel: "//core:dag_codec_test",
    projectName: "typed-ski-dag-codec-test",
    projectFileBase: "typed-ski-dag-codec-test",
    outputName: "dag_codec_test.exe",
    sourceFiles: [
      "core\\\\arena.c",
      "core\\\\dag_codec_test.c",
      "core\\\\host_platform_windows.c",
      "core\\\\ski_io.c",
      "core\\\\util.c",
    ],
  },
  {
    bazelLabel: "//core:session_test",
    projectName: "typed-ski-session-test",
    projectFileBase: "typed-ski-session-test",
    outputName: "session_test.exe",
    sourceFiles: [
      "core\\\\arena.c",
      "core\\\\host_platform_windows.c",
      "core\\\\session.c",
      "core\\\\session_test.c",
      "core\\\\ski_io.c",
      "core\\\\thanatos.c",
      "core\\\\util.c",
    ],
  },
  {
    bazelLabel: "//core:performance_test",
    projectName: "typed-ski-performance-test",
    projectFileBase: "typed-ski-performance-test",
    outputName: "performance_test.exe",
    debuggerArgs: "8 67108864 256 5 4294967295",
    sourceFiles: [
      "core\\\\arena.c",
      "core\\\\host_platform_windows.c",
      "core\\\\performance_test.c",
      "core\\\\session.c",
      "core\\\\ski_io.c",
      "core\\\\thanatos.c",
      "core\\\\util.c",
    ],
  },
  {
    bazelLabel: "//core:ski_io_test",
    projectName: "typed-ski-ski-io-test",
    projectFileBase: "typed-ski-ski-io-test",
    outputName: "ski_io_test.exe",
    sourceFiles: [
      "core\\\\arena.c",
      "core\\\\host_platform_windows.c",
      "core\\\\session.c",
      "core\\\\ski_io.c",
      "core\\\\ski_io_test.c",
      "core\\\\thanatos.c",
      "core\\\\util.c",
    ],
  },
  {
    bazelLabel: "//core:util_test",
    projectName: "typed-ski-util-test",
    projectFileBase: "typed-ski-util-test",
    outputName: "util_test.exe",
    sourceFiles: ["core\\\\util.c", "core\\\\util_test.c"],
  },
];

function buildVcxproj(
  template: string,
  target: VisualStudioNativeTarget,
  projectGuid: string,
  outputPath: string,
  includeDirs: string[],
  defines: string[],
  headers: string[],
): string {
  const joinedIncludes = dedupe(includeDirs).map(xmlEscape).join(";");
  const joinedDefines = dedupe(defines).map(xmlEscape).join(";");
  const makeCommand = `bazelisk build ${target.bazelLabel}`;
  const rebuildCommand = `cmd /c "bazelisk clean && bazelisk build ${target.bazelLabel}"`;
  const cleanCommand = "bazelisk clean";
  const sourceItems = target.sourceFiles
    .map((file) => `    <ClCompile Include="${xmlEscape(file)}" />`)
    .join("\n");
  const headerItems = headers
    .map((file) => `    <ClInclude Include="${xmlEscape(file)}" />`)
    .join("\n");
  return renderPositionalTemplate(template, [
    xmlEscape(projectGuid),
    xmlEscape(target.projectName.replaceAll("-", "_")),
    xmlEscape(target.projectName),
    xmlEscape(makeCommand),
    xmlEscape(rebuildCommand),
    xmlEscape(cleanCommand),
    xmlEscape(outputPath),
    joinedIncludes,
    joinedDefines,
    xmlEscape(outputPath),
    xmlEscape(target.debuggerArgs ?? ""),
    joinedDefines,
    joinedIncludes,
    joinedDefines,
    joinedIncludes,
    sourceItems,
    headerItems,
  ]);
}

function buildVcxprojFilters(
  target: VisualStudioNativeTarget,
  headers: string[],
): string {
  const sourceItems = target.sourceFiles
    .map(
      (file) =>
        `    <ClCompile Include="${xmlEscape(file)}"><Filter>Source Files</Filter></ClCompile>`,
    )
    .join("\n");
  const headerItems = headers
    .map(
      (file) =>
        `    <ClInclude Include="${xmlEscape(file)}"><Filter>Header Files</Filter></ClInclude>`,
    )
    .join("\n");

  return `<?xml version="1.0" encoding="utf-8"?>
<Project ToolsVersion="4.0" xmlns="http://schemas.microsoft.com/developer/msbuild/2003">
  <ItemGroup>
    <Filter Include="Source Files">
      <UniqueIdentifier>{59A59C49-1A1B-49C8-8EA2-5E46C733A32A}</UniqueIdentifier>
    </Filter>
    <Filter Include="Header Files">
      <UniqueIdentifier>{58F7D328-E2D4-4C44-B6A5-54E12A6E30C0}</UniqueIdentifier>
    </Filter>
  </ItemGroup>
  <ItemGroup>
${sourceItems}
${headerItems}
  </ItemGroup>
</Project>
`;
}

function buildSolution(
  projects: Array<{
    projectName: string;
    projectFileBase: string;
    projectGuid: string;
  }>,
): string {
  const projectEntries = projects
    .map(
      (
        project,
      ) => `Project("{BC8A1FFA-BEE3-4634-8014-F334798102B3}") = "${project.projectName}", "${project.projectFileBase}.vcxproj", "${project.projectGuid}"
EndProject`,
    )
    .join("\n");
  const projectConfigs = projects
    .map(
      (project) => `\t\t${project.projectGuid}.Debug|x64.ActiveCfg = Debug|x64
\t\t${project.projectGuid}.Debug|x64.Build.0 = Debug|x64
\t\t${project.projectGuid}.Release|x64.ActiveCfg = Release|x64
\t\t${project.projectGuid}.Release|x64.Build.0 = Release|x64`,
    )
    .join("\n");

  return `Microsoft Visual Studio Solution File, Format Version 12.00
# Visual Studio Version 17
VisualStudioVersion = 17.0.31903.59
MinimumVisualStudioVersion = 10.0.40219.1
${projectEntries}
Global
	GlobalSection(SolutionConfigurationPlatforms) = preSolution
		Debug|x64 = Debug|x64
		Release|x64 = Release|x64
	EndGlobalSection
	GlobalSection(ProjectConfigurationPlatforms) = postSolution
${projectConfigs}
	EndGlobalSection
	GlobalSection(SolutionProperties) = preSolution
		HideSolutionNode = FALSE
	EndGlobalSection
EndGlobal
`;
}

async function generateVisualStudioProject(): Promise<void> {
  const executionRoot = await runCapture([BAZELISK, "info", "execution_root"]);
  const bazelBin = await runCapture([BAZELISK, "info", "bazel-bin"]);
  const aqueryOutput = await runCapture([
    BAZELISK,
    "aquery",
    "mnemonic('CppCompile', //core:all)",
    "--output=jsonproto",
  ]);
  const aquery = JSON.parse(aqueryOutput) as AqueryResponse;
  const vcxprojTemplate = await fsp.readFile(
    join(PROJECT_ROOT, "scripts", "templates", "vcxproj.xml.tpl"),
    "utf8",
  );
  const { headers } = await collectCoreFiles();

  const targets = new Map<number, AqueryTarget>(
    (aquery.targets ?? []).map((target) => [target.id, target]),
  );

  function resolveActionPath(path: string): string {
    if (/^[A-Za-z]:[\\/]/.test(path) || path.startsWith("/")) return path;
    if (path === "." || path === "") return PROJECT_ROOT;
    if (path.startsWith("external/")) return join(executionRoot, path);
    return join(PROJECT_ROOT, path);
  }

  const includeDirs: string[] = [];
  const defines: string[] = [];
  const compileCommands: Array<Record<string, unknown>> = [];
  let compilerPath: string | undefined;

  for (const action of aquery.actions ?? []) {
    if (action.mnemonic !== "CppCompile" || !action.arguments?.length) continue;

    const args = [...action.arguments];
    compilerPath ??= resolveActionPath(args[0]!);

    let sourcePath: string | undefined;

    for (let index = 1; index < args.length; index += 1) {
      const arg = args[index]!;
      if (arg === "-c" && index + 1 < args.length) {
        sourcePath = resolveActionPath(args[index + 1]!);
        index += 1;
        continue;
      }
      if (
        (arg === "-I" ||
          arg === "-isystem" ||
          arg === "-iquote" ||
          arg === "/I") &&
        index + 1 < args.length
      ) {
        includeDirs.push(resolveActionPath(args[index + 1]!));
        index += 1;
        continue;
      }
      if (
        (arg.startsWith("-I") ||
          arg.startsWith("-isystem") ||
          arg.startsWith("-iquote")) &&
        !["-I", "-isystem", "-iquote"].includes(arg)
      ) {
        const prefix = arg.startsWith("-isystem")
          ? "-isystem"
          : arg.startsWith("-iquote")
            ? "-iquote"
            : "-I";
        includeDirs.push(resolveActionPath(arg.slice(prefix.length)));
        continue;
      }
      if (arg === "-D" && index + 1 < args.length) {
        defines.push(args[index + 1]!);
        index += 1;
        continue;
      }
      if (arg.startsWith("-D") && arg.length > 2) {
        defines.push(arg.slice(2));
      }
    }

    if (!sourcePath) continue;

    const targetLabel = targets.get(action.targetId)?.label ?? "//unknown";
    compileCommands.push({
      directory: executionRoot,
      file: sourcePath,
      arguments: args,
      target: targetLabel,
    });
  }

  if (compileCommands.length === 0) {
    throw new Error("No Bazel CppCompile actions were found for //core:all");
  }

  const normalizedCompileCommands = compileCommands.map((entry) => {
    const rawArgs = entry.arguments as string[];
    return {
      directory: executionRoot,
      file: entry.file,
      command: rawArgs.map(quoteCommandArgument).join(" "),
    };
  });

  const cppProperties = {
    configurations: [
      {
        name: "Bazel-x64-Debug",
        includePath: dedupe([
          "${workspaceRoot}\\\\**",
          ...includeDirs.map(toWorkspaceOrAbsolutePath),
        ]),
        defines: dedupe(defines),
        intelliSenseMode: "windows-clang-x64",
        compilerPath: compilerPath
          ? toWorkspaceOrAbsolutePath(compilerPath)
          : undefined,
      },
    ],
  };

  const tasksVs = {
    version: "0.2.1",
    tasks: [
      {
        taskLabel: "bazel build thanatos",
        appliesTo: "/",
        type: "default",
        command: BAZELISK,
        args: ["build", "//:thanatos"],
      },
      {
        taskLabel: "bazel test native_tests",
        appliesTo: "/",
        type: "default",
        command: BAZELISK,
        args: ["test", "//:native_tests"],
      },
      {
        taskLabel: "bazel refresh Visual Studio metadata",
        appliesTo: "/",
        type: "default",
        command: BAZELISK,
        args: ["run", "//:vs_project"],
      },
    ],
  };

  const thanatosExe = join(
    bazelBin,
    "core",
    process.platform === "win32" ? "thanatos.exe" : "thanatos",
  );
  const slnPath = join(PROJECT_ROOT, "typed-ski-native.sln");
  const launchVs = {
    version: "0.2.1",
    defaults: {},
    configurations: [
      {
        type: "cppdbg",
        name: "thanatos (Bazel)",
        project: toWorkspaceOrAbsolutePath(thanatosExe),
        cwd: "${workspaceRoot}",
        program: toWorkspaceOrAbsolutePath(thanatosExe),
        MIMode: "gdb",
        externalConsole: true,
      },
    ],
  };

  await fsp.mkdir(join(PROJECT_ROOT, ".vs"), { recursive: true });
  await fsp.writeFile(
    join(PROJECT_ROOT, "compile_commands.json"),
    JSON.stringify(normalizedCompileCommands, null, 2) + "\n",
  );
  await fsp.writeFile(
    join(PROJECT_ROOT, "CppProperties.json"),
    JSON.stringify(cppProperties, null, 2) + "\n",
  );
  await fsp.writeFile(
    join(PROJECT_ROOT, ".vs", "tasks.vs.json"),
    JSON.stringify(tasksVs, null, 2) + "\n",
  );
  await fsp.writeFile(
    join(PROJECT_ROOT, ".vs", "launch.vs.json"),
    JSON.stringify(launchVs, null, 2) + "\n",
  );

  const solutionProjects: Array<{
    projectName: string;
    projectFileBase: string;
    projectGuid: string;
  }> = [];
  for (const [index, target] of VISUAL_STUDIO_NATIVE_TARGETS.entries()) {
    const projectGuid = `{A0C107C5-4E25-4B7D-9201-B7B1A41E3${(0x1b + index).toString(16).toUpperCase().padStart(2, "0")}}`;
    const outputPath = join(bazelBin, "core", target.outputName);
    const vcxprojPath = join(PROJECT_ROOT, `${target.projectFileBase}.vcxproj`);
    const vcxprojFiltersPath = join(
      PROJECT_ROOT,
      `${target.projectFileBase}.vcxproj.filters`,
    );
    const vcxprojContent = buildVcxproj(
      vcxprojTemplate,
      target,
      projectGuid,
      outputPath,
      includeDirs,
      defines,
      headers,
    );

    await fsp.writeFile(vcxprojPath, vcxprojContent);
    await fsp.writeFile(
      vcxprojFiltersPath,
      buildVcxprojFilters(target, headers),
    );
    solutionProjects.push({
      projectName: target.projectName,
      projectFileBase: target.projectFileBase,
      projectGuid,
    });
  }
  await fsp.writeFile(slnPath, buildSolution(solutionProjects));

  console.log("Wrote Visual Studio metadata:");
  console.log("  compile_commands.json");
  console.log("  CppProperties.json");
  console.log("  .vs/tasks.vs.json");
  console.log("  .vs/launch.vs.json");
  console.log("  typed-ski-native.sln");
  for (const target of VISUAL_STUDIO_NATIVE_TARGETS) {
    console.log(`  ${target.projectFileBase}.vcxproj`);
    console.log(`  ${target.projectFileBase}.vcxproj.filters`);
  }
  console.log("");
  console.log(
    "Open the repo with Visual Studio's Open Folder workflow or the generated .sln.",
  );
  console.log(
    "If gdb.exe is not on PATH, edit .vs/launch.vs.json and set miDebuggerPath.",
  );
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
    case "hephaestus-assets":
      await buildHephaestusAssets();
      break;
    case "serve-hephaestus":
      await serveHephaestus();
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
    case "vs-project":
      await generateVisualStudioProject();
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
