#!/usr/bin/env -S deno run -A

import { join, relative, toFileUrl } from "std/path";
import {
  assertCurrentDenoVersion,
  getRepoVersion,
  getRequiredDenoVersion,
  PROJECT_ROOT,
} from "./repoDeno.ts";

type CommandName =
  | "verify-version"
  | "sync-generated"
  | "dist"
  | "build"
  | "hephaestus-assets"
  | "serve-hephaestus"
  | "fmt-check"
  | "lint"
  | "test"
  | "coverage"
  | "ci";

const DENO = Deno.execPath();
const TEMP_ROOT = Deno.build.os === "windows"
  ? Deno.env.get("LOCALAPPDATA") ?? Deno.env.get("TEMP") ??
    Deno.env.get("TMP") ?? "."
  : Deno.env.get("TMPDIR") ?? "/tmp";
const DENO_DIR = Deno.env.get("TYPED_SKI_DENO_DIR") ??
  join(TEMP_ROOT, "typed-ski-deno-cache");
const COMPILED_TRIPC_NAME = Deno.build.os === "windows" ? "tripc.exe" : "tripc";
const BAZEL_RELEASE_WASM_CANDIDATES = [
  join(PROJECT_ROOT, "bazel-bin", "wasm", "release.wasm"),
];
const DENO_TEST_BASE_ARGS = [
  DENO,
  "test",
  "--allow-read",
  "--allow-write",
  "--allow-run",
  "--allow-env",
];

function denoTestArgs(
  files: string[],
  options: { coverage?: string } = {},
): string[] {
  const args = [...DENO_TEST_BASE_ARGS];
  args.push("--parallel");
  if (options.coverage) {
    args.push(`--coverage=${options.coverage}`);
  }
  args.push(...files);
  return args;
}

function usage(): never {
  console.error(`Usage: deno run -A scripts/bazel.ts <command>

Commands:
  verify-version
  sync-generated
  dist
  build
  hephaestus-assets
  serve-hephaestus
  fmt-check
  lint
  test
  coverage
  ci`);
  Deno.exit(1);
}

async function run(
  args: string[],
  options: Deno.CommandOptions = {},
): Promise<void> {
  const { env: extraEnv, ...rest } = options;
  const command = new Deno.Command(
    args[0]!,
    {
      args: args.slice(1),
      cwd: PROJECT_ROOT,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
      env: {
        ...Deno.env.toObject(),
        DENO_DIR,
        ...extraEnv,
      },
      ...rest,
    },
  );
  const { code } = await command.output();
  if (code !== 0) {
    throw new Error(`Command failed with exit code ${code}: ${args.join(" ")}`);
  }
}

function verifyVersion(): void {
  const version = getRepoVersion();
  const denoVersion = getRequiredDenoVersion();
  console.log(`Version in deno.jsonc: ${version}`);
  console.log(`Required Deno version: ${denoVersion}`);
}

async function syncGenerated(): Promise<void> {
  await run([DENO, "run", "-A", "scripts/generateVersion.ts"]);
  await run([DENO, "run", "-A", "scripts/generateArenaHeaderC.ts"]);
}

async function buildDist(): Promise<void> {
  await Deno.mkdir(join(PROJECT_ROOT, "dist"), { recursive: true });
  await run([DENO, "bundle", "-o", "dist/tripc.js", "bin/tripc.ts"]);
  await run([
    DENO,
    "bundle",
    "--minify",
    "-o",
    "dist/tripc.min.js",
    "bin/tripc.ts",
  ]);
  await run([
    DENO,
    "bundle",
    "--platform=browser",
    "-o",
    "dist/tripc.node.js",
    "bin/tripc.ts",
  ]);
  const compileTempDir = join(TEMP_ROOT, "typed-ski-build");
  const compileTempPath = join(compileTempDir, COMPILED_TRIPC_NAME);
  const finalBinaryPath = join(PROJECT_ROOT, "dist", COMPILED_TRIPC_NAME);

  await Deno.mkdir(compileTempDir, { recursive: true });
  await run([
    DENO,
    "compile",
    "--allow-read",
    "--allow-write",
    "--output",
    compileTempPath,
    "bin/tripc.ts",
  ]);
  const compiledBinary = await Deno.readFile(compileTempPath);
  await Deno.writeFile(finalBinaryPath, compiledBinary);
  if (Deno.build.os !== "windows") {
    await Deno.chmod(finalBinaryPath, 0o755).catch(() => {});
  }
}

async function buildHephaestusAssets(): Promise<void> {
  await syncGenerated();
  await Deno.mkdir(join(PROJECT_ROOT, "dist"), { recursive: true });
  await run([
    DENO,
    "bundle",
    "--no-check",
    "--platform=browser",
    "-o",
    "dist/workbench.js",
    "server/workbench.js",
  ]);
  await run([
    DENO,
    "bundle",
    "--no-check",
    "--platform=browser",
    "-o",
    "dist/webglForest.js",
    "server/webglForest.ts",
  ]);
  await run([
    DENO,
    "bundle",
    "--no-check",
    "--platform=browser",
    "-o",
    "dist/arenaWorker.js",
    "lib/evaluator/arenaWorker.ts",
  ]);
}

function getBazelWasmArtifactUrl(): string | undefined {
  for (const candidate of BAZEL_RELEASE_WASM_CANDIDATES) {
    try {
      const stat = Deno.statSync(candidate);
      if (stat.isFile) return toFileUrl(candidate).href;
    } catch {
      // Ignore missing Bazel outputs and fall through to the next candidate.
    }
  }
  return undefined;
}

async function serveHephaestus(): Promise<void> {
  await buildHephaestusAssets();
  const port = Deno.env.get("PORT") ?? "8080";
  await run([
    DENO,
    "run",
    "-c",
    "server/deno.json",
    "--allow-net",
    "--allow-read",
    "--allow-env",
    "--allow-run",
    "server/serveWorkbench.ts",
    port,
  ]);
}

async function formatCheck(): Promise<void> {
  await run([DENO, "fmt", "--check"]);
}

async function lint(): Promise<void> {
  await run([DENO, "lint"]);
}

async function collectPortableTests(): Promise<string[]> {
  const testRoot = join(PROJECT_ROOT, "test");
  const files: string[] = [];

  async function walk(dir: string): Promise<void> {
    for await (const entry of Deno.readDir(dir)) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory) {
        await walk(fullPath);
        continue;
      }
      if (!entry.isFile || !entry.name.endsWith(".test.ts")) continue;
      const relPath = relative(PROJECT_ROOT, fullPath).replaceAll("\\", "/");
      files.push(relPath);
    }
  }

  await walk(testRoot);
  files.sort();
  return files;
}

async function runPortableTests(withCoverage: boolean): Promise<void> {
  await syncGenerated();
  const wasmUrl = getBazelWasmArtifactUrl();
  const env = wasmUrl ? { TYPED_SKI_WASM_PATH: wasmUrl } : {};

  const files = await collectPortableTests();
  if (files.length === 0) {
    throw new Error("No portable test files were selected");
  }

  if (withCoverage) {
    await Deno.remove(join(PROJECT_ROOT, "coverage"), { recursive: true })
      .catch(() => {});
    await run(denoTestArgs(files, { coverage: "coverage" }), { env });
    await run([
      DENO,
      "coverage",
      "coverage",
      "--lcov",
      "--output=coverage.lcov",
    ]);
    return;
  }

  await run(denoTestArgs(files), { env });
}

async function build(): Promise<void> {
  verifyVersion();
  await syncGenerated();
  await buildDist();
}

async function ci(): Promise<void> {
  verifyVersion();
  await syncGenerated();
  await buildDist();
  await formatCheck();
  await lint();

  const wasmUrl = getBazelWasmArtifactUrl();
  const env = wasmUrl ? { TYPED_SKI_WASM_PATH: wasmUrl } : {};

  const files = await collectPortableTests();
  await run(denoTestArgs(files), { env });

  await Deno.remove(join(PROJECT_ROOT, "coverage"), { recursive: true }).catch(
    () => {},
  );
  await run(denoTestArgs(files, { coverage: "coverage" }), { env });
  await run([DENO, "coverage", "coverage", "--lcov", "--output=coverage.lcov"]);
}

const command = Deno.args[0] as CommandName | undefined;
if (!command) usage();
assertCurrentDenoVersion();

switch (command) {
  case "verify-version":
    verifyVersion();
    break;
  case "sync-generated":
    await syncGenerated();
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
  case "test":
    await runPortableTests(false);
    break;
  case "coverage":
    await runPortableTests(true);
    break;
  case "ci":
    await ci();
    break;
  default:
    usage();
}
