#!/usr/bin/env -S node --disable-warning=ExperimentalWarning

import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";

import * as process from "node:process";
import { spawn, spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
// JS_ROOT: directory containing compiled .js outputs (one level up from scripts/)
// In Bazel: <runfiles>/ts_out, locally (after build): <project>/out
const JS_ROOT = join(__dirname, "..");
// PROJECT_ROOT: source root with package.json, node_modules, tsconfig, etc.
// Two levels up because compiled scripts live in ts_out/scripts/ or out/scripts/.
// Overridden by TYPED_SKI_PROJECT_ROOT when bazelBuildDist runs with a workspace copy.
const PROJECT_ROOT =
  process.env["TYPED_SKI_PROJECT_ROOT"] ?? join(__dirname, "../..");
const PACKAGE_JSON_PATH = join(PROJECT_ROOT, "package.json");

type PackageJson = {
  version: string;
  engines?: {
    node?: string;
  };
};

function readPackageJson(): PackageJson {
  return JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, "utf8")) as PackageJson;
}

function getRepoVersion(): string {
  return readPackageJson().version;
}

function getRequiredNodeVersion(): string {
  return readPackageJson().engines?.node ?? "25.x";
}

function getRequiredNodeMajor(): number | null {
  const required = getRequiredNodeVersion();
  const major = required.match(/(\d+)/)?.[1];
  return major === undefined ? null : Number(major);
}

function assertCurrentNodeVersion(): void {
  if (process.env["TYPED_SKI_SKIP_NODE_VERSION_CHECK"] === "1") {
    return;
  }

  const current = process.version.replace("v", "");
  const required = getRequiredNodeVersion();
  const requiredMajor = getRequiredNodeMajor();
  const currentMajor = Number(current.split(".")[0]);

  if (requiredMajor !== null && currentMajor !== requiredMajor) {
    console.warn(
      `Warning: This repo expects Node ${required}, but found ${current}.`,
    );
  }
}

type CommandName =
  | "verify-version"
  | "sync-generated"
  | "verify-generated"
  | "dist"
  | "build"
  | "fmt-check"
  | "typecheck"
  | "test"
  | "bazel-test-shard";

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
const NODE_TEST_GLOBAL_SETUP_PATH = join(JS_ROOT, "test", "globalSetup.js");
const TEMP_ROOT =
  process.platform === "win32"
    ? (process.env["LOCALAPPDATA"] ??
      process.env["TEMP"] ??
      process.env["TMP"] ??
      ".")
    : (process.env["TMPDIR"] ?? "/tmp");

const COMPILED_TRIPC_NAME =
  process.platform === "win32" ? "tripc.cmd" : "tripc";

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
  const tempRoot = process.env["TEST_TMPDIR"] ?? join(PROJECT_ROOT, ".tmp");
  const storeDir = join(tempRoot, "pnpm-store");
  await fsp.mkdir(storeDir, { recursive: true });
  return storeDir;
}
const DIST_REQUIRED_TESTS = new Set(["test/bin/cli.test.js"]);

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
  args.push("--preserve-symlinks-main");

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
  console.error(`Usage: node --disable-warning=ExperimentalWarning out/scripts/bazel.js <command>

Commands:
  verify-version
  sync-generated
  verify-generated
  dist
  build
  fmt-check
  typecheck
  test
  bazel-test-shard`);
  process.exit(1);
}

async function run(args: string[], options: any = {}): Promise<void> {
  const { env: extraEnv, timeoutMs, cwd: cwdOverride, ...rest } = options;
  const pnpmStore = await ensurePnpmStore();
  return new Promise((resolve, reject) => {
    const [command, commandArgs] = splitSpawnArgs(args);
    const child = spawn(command, commandArgs, {
      cwd: cwdOverride ?? PROJECT_ROOT,
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
  const { env: extraEnv, cwd: cwdOverride, ...rest } = options;
  const pnpmStore = await ensurePnpmStore();
  return new Promise((resolve, reject) => {
    const [command, commandArgs] = splitSpawnArgs(args);
    const child = spawn(command, commandArgs, {
      cwd: cwdOverride ?? PROJECT_ROOT,
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
  console.log("Generated files are up to date.");
}

async function ensurePreconditions(
  options: {
    sync?: boolean;
  } = {},
): Promise<void> {
  if (options.sync) {
    await syncGenerated();
  }
}

async function validateDist(): Promise<void> {
  const requiredFiles = [
    "dist/tripc.js",
    "dist/tripc.min.js",
    "dist/tripc.node.js",
    process.platform === "win32" ? "dist/tripc.cmd" : "dist/tripc",
  ];

  for (const file of requiredFiles) {
    const fullPath = join(PROJECT_ROOT, file);
    if (!fs.existsSync(fullPath)) {
      throw new Error(`Distribution validation failed: Missing ${file}`);
    }
  }

  console.log("Distribution validation successful.");
}

export async function buildDist(
  options: {
    sync?: boolean;
  } = { sync: true },
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

async function formatCheck(): Promise<void> {
  console.log("Format check using pnpm exec prettier --check .");
  await run(pnpmCommand("exec", "prettier", "--check", "."));
}

async function collectTests(): Promise<string[]> {
  const testRoot = join(JS_ROOT, "test");
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
      } else if (isFile && entry.name.endsWith(".test.js")) {
        const relPath = relative(JS_ROOT, fullPath).replaceAll("\\", "/");
        files.push(relPath);
      }
    }
  }

  await walk(testRoot);
  files.sort();
  console.log(`Found ${files.length} test files.`);
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
      cwd: JS_ROOT,
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
  console.log(`JS_ROOT: ${JS_ROOT}`);
  if (fs.existsSync(JS_ROOT)) {
    try {
      const contents = fs.readdirSync(JS_ROOT);
      console.log(`Contents of JS_ROOT: ${contents.join(", ")}`);
    } catch (e) {
      console.error(`Error reading JS_ROOT: ${e}`);
    }
  } else {
    console.warn(`JS_ROOT does not exist: ${JS_ROOT}`);
  }

  for (const key of Object.keys(process.env)) {
    if (key.startsWith("TYPED_SKI_")) {
      console.log(`[env] ${key}: ${process.env[key]}`);
    }
  }
  if (
    needsDistArtifacts(files) &&
    process.env["TYPED_SKI_DIST_READY"] !== "1"
  ) {
    console.log("Building distribution artifacts for tests...");
    await buildDist();
  }

  const env: Record<string, string> = {
    // Inject the authoritative workspace root so every consumer can import
    // lib/shared/workspaceRoot.ts and get the correct path without having to
    // count directory levels relative to their own compiled location.
    TYPED_SKI_PROJECT_ROOT: PROJECT_ROOT,
  };

  if (process.env["TEST_SRCDIR"] && process.env["TEST_WORKSPACE"]) {
    const nodeOptions = [
      process.env["NODE_OPTIONS"],
      "--preserve-symlinks",
      "--preserve-symlinks-main",
    ]
      .filter((value) => value && value.length > 0)
      .join(" ");

    env.NODE_OPTIONS = nodeOptions;
  }

  return env;
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

  if (process.env["TYPED_SKI_SHUFFLE_TESTS"] === "1") {
    console.log("Shuffling test files for randomized execution order...");
    for (let i = files.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [files[i], files[j]] = [files[j]!, files[i]!];
    }
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
