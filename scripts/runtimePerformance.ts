/** Controlled runtime trial; generated program bytes and Clang flags stay fixed. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { arch, cpus, platform, release } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  compileTripSourceToLlvm,
  serializeTripBundleV1,
} from "../lib/compiler/index.ts";
import {
  ALL_COMPILER_TRIP_MODULE_NAMES,
  compilerTripModuleSourcePath,
} from "../lib/compiler/bootstrapModules.ts";
import { findLocalClangPath } from "../lib/shared/clangPath.ts";
import { workspaceRoot } from "../lib/shared/workspaceRoot.ts";

const MAIN = "ea97a8286fe88a16f84cd4ec673a103cad0a1791";
const HARDENING = "7a447a6d8a738815e6cc9964a4b320d88be5749d";
const argv = process.argv.slice(2);
if (argv.includes("--help")) {
  console.log(`Usage: node ts_out/scripts/runtimePerformance.js [options]
  --output PATH                 JSON results (default: runtime-performance.json)
  --work-dir PATH               Native artifacts (default: .tmp/runtime-performance)
  --repetitions N               C workload samples (default: 5)
  --compiler-repetitions N      Full compiler samples (default: 3)
  --allocation-count N          Mixed objects (default: 1000000)
  --access-count N              Object accessor iterations (default: 4000000)
  --io-bytes N                  Binary I/O fixture bytes (default: 1048576)
  --skip-bootstrap              C workloads only
  --runtime-only                Omit the Stage-2 compiler design comparison
  --compiler-only               Omit C workloads
  --emission-only               Stage-2 compiler design comparison only
  --prepare-only                Compile artifacts without timed trials
  --compiler-source-ref REF     Frozen compiler source (default: predecessor main)
  --hardening-ref REF           Override the checked-in historical runtime snapshot`);
  process.exit(0);
}
const option = (name: string, fallback: string): string => {
  const index = argv.indexOf(name);
  if (index < 0) return fallback;
  const value = argv[index + 1];
  if (!value || value.startsWith("--"))
    throw new Error(`${name} needs a value`);
  return value;
};
const positiveInteger = (name: string, fallback: number): number => {
  const value = Number(option(name, String(fallback)));
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
};
const repetitions = positiveInteger("--repetitions", 5);
const compilerRepetitions = positiveInteger("--compiler-repetitions", 3);
const allocationCount = positiveInteger("--allocation-count", 1_000_000);
const accessCount = positiveInteger("--access-count", 4_000_000);
const ioBytes = positiveInteger("--io-bytes", 1_048_576);
const workDir = resolve(
  workspaceRoot,
  option("--work-dir", ".tmp/runtime-performance"),
);
const outputPath = resolve(
  workspaceRoot,
  option("--output", "runtime-performance.json"),
);
const sourceRef = option("--compiler-source-ref", MAIN);
const hardeningRef = option("--hardening-ref", "snapshot");
const skipBootstrap = argv.includes("--skip-bootstrap");
const runtimeOnly = argv.includes("--runtime-only");
const emissionOnly = argv.includes("--emission-only");
const compilerOnly = argv.includes("--compiler-only") || emissionOnly;
if ((skipBootstrap && compilerOnly) || (emissionOnly && runtimeOnly)) {
  throw new Error(
    "Options exclude all workloads; choose a runtime or compiler trial",
  );
}
const clang = process.env["TYPED_SKI_CLANG"] ?? findLocalClangPath();
if (!clang) throw new Error("Set TYPED_SKI_CLANG to the Clang executable");

function capture(command: string, args: string[]): Buffer {
  const result = spawnSync(command, args, {
    cwd: workspaceRoot,
    maxBuffer: 128 * 1024 * 1024,
    timeout: 240_000,
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      `${command} failed: ${result.error ?? result.stderr.toString()}`,
    );
  }
  return result.stdout;
}

const git = (...args: string[]): Buffer => capture("git", args);
const sha256 = (bytes: string | Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

async function fingerprintCode(directory: string, extension: string) {
  const paths = (await readdir(directory, { recursive: true }))
    .filter((path) => path.endsWith(extension))
    .sort();
  const hash = createHash("sha256").update(process.version);
  for (const path of paths) {
    hash
      .update(path.replaceAll("\\", "/"))
      .update("\0")
      .update(await readFile(join(directory, path)))
      .update("\0");
  }
  return { files: paths.length, sha256: hash.digest("hex") };
}

// Capture the actual host/harness bytes before compilation or measurements.
// A stale ts_out is a distinct host identity, even when source TS has changed.
const executedEntryPath = fileURLToPath(import.meta.url);
const executedHostDirectory = resolve(dirname(executedEntryPath), "../lib");
const executedHost = await fingerprintCode(
  executedHostDirectory,
  executedEntryPath.endsWith(".ts") ? ".ts" : ".js",
);
const sourceHost = await fingerprintCode(join(workspaceRoot, "lib"), ".ts");
let lockfileSha256: string | null = null;
try {
  lockfileSha256 = sha256(
    await readFile(join(workspaceRoot, "pnpm-lock.yaml")),
  );
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}
const startupIdentity = {
  executedHarnessPath: relative(workspaceRoot, executedEntryPath).replaceAll(
    "\\",
    "/",
  ),
  executedHarnessSha256: sha256(await readFile(executedEntryPath)),
  sourceHarnessSha256: sha256(
    await readFile(join(workspaceRoot, "scripts/runtimePerformance.ts")),
  ),
  executedHostDirectory: relative(
    workspaceRoot,
    executedHostDirectory,
  ).replaceAll("\\", "/"),
  executedHost,
  sourceHost,
  node: process.version,
  lockfileSha256,
};
const executableSuffix = process.platform === "win32" ? ".exe" : "";
const sdkFlags =
  process.platform === "darwin"
    ? [
        "-isysroot",
        process.env["SDKROOT"] ??
          capture("xcrun", ["--show-sdk-path"]).toString().trim(),
      ]
    : [];
const flags = [
  "-O3",
  "-std=c11",
  ...sdkFlags,
  ...(process.platform === "win32"
    ? []
    : ["-D_POSIX_C_SOURCE=200809L", "-D_GNU_SOURCE"]),
  ...(process.platform === "darwin" ? ["-D_DARWIN_C_SOURCE"] : []),
];

type RuntimeVersion = {
  label: string;
  revision: string;
  sourceSha256: string;
  headerSha256: string;
  directory: string;
  fixtureExe: string;
  compilerExe?: string;
};

type AllocationStats = {
  objects: number;
  objectBytes: number;
  reservedBytes: number;
  chunks: number;
};

type Sample = {
  elapsedMs: number;
  peakRssBytes: number;
  outputBytes: number;
  outputSha256: string;
  allocations: AllocationStats | null;
};

function execute(
  exe: string,
  args: string[],
  input: Uint8Array | undefined,
  buffered: boolean,
): { sample: Sample; output: Buffer } {
  const result = spawnSync(monitorExe, [exe, ...args], {
    cwd: workspaceRoot,
    input,
    env: {
      ...process.env,
      TRIP_RUNTIME_STATS: "1",
      TRIP_RUNTIME_BUFFER_OUTPUT: buffered ? "1" : "0",
    },
    maxBuffer: 128 * 1024 * 1024,
    timeout: 240_000,
  });
  const stderr = result.stderr?.toString() ?? "";
  assert.equal(result.error, undefined, String(result.error));
  assert.equal(result.status, 0, stderr);
  const measured =
    /benchmark monitor: peak_rss_bytes=(\d+) elapsed_ms=([\d.]+)/.exec(stderr);
  assert.ok(measured, `OS process measurements missing: ${stderr}`);
  assert.ok(
    Number(measured[1]) > 0,
    `OS returned an empty peak-memory result: ${stderr}`,
  );
  const stats =
    /trip arena: objects=(\d+) object_bytes=(\d+) reserved_bytes=(\d+) chunks=(\d+)/.exec(
      stderr,
    );
  const output = result.stdout;
  return {
    sample: {
      elapsedMs: Number(measured[2]),
      peakRssBytes: Number(measured[1]),
      outputBytes: output.length,
      outputSha256: sha256(output),
      allocations: stats
        ? {
            objects: Number(stats[1]),
            objectBytes: Number(stats[2]),
            reservedBytes: Number(stats[3]),
            chunks: Number(stats[4]),
          }
        : null,
    },
    output,
  };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

type Trial = {
  workload: string;
  bufferedOutput: boolean;
  repetitions: number;
  results: Array<{
    version: string;
    medianMs: number;
    minMs: number;
    maxMs: number;
    medianPeakRssBytes: number;
    samples: Sample[];
  }>;
};

const trials: Trial[] = [];
async function trial(
  workload: string,
  versions: Array<{ label: string; exe: string }>,
  args: string[],
  input: Uint8Array | undefined,
  expectedSha256: string | undefined,
  count: number,
  buffered: boolean,
): Promise<Map<string, Buffer>> {
  console.log(
    `Measuring ${workload} (${count} repetitions, buffered=${buffered})...`,
  );
  const samples = new Map<string, Sample[]>();
  const outputs = new Map<string, Buffer>();
  const hashes = new Map<string, string>();
  for (const version of versions) {
    const warmup = execute(version.exe, args, input, buffered);
    if (expectedSha256)
      assert.equal(warmup.sample.outputSha256, expectedSha256, workload);
    hashes.set(version.label, warmup.sample.outputSha256);
    samples.set(version.label, []);
    outputs.set(version.label, warmup.output);
  }
  for (let repetition = 0; repetition < count; repetition++) {
    // Serial runs, with starting version rotated to limit order/thermal bias.
    const order = versions.map(
      (_, index) => versions[(index + repetition) % versions.length]!,
    );
    for (const version of order) {
      const run = execute(version.exe, args, input, buffered);
      assert.equal(
        run.sample.outputSha256,
        hashes.get(version.label),
        `${workload} output changed`,
      );
      samples.get(version.label)!.push(run.sample);
    }
  }
  const recorded: Trial = {
    workload,
    bufferedOutput: buffered,
    repetitions: count,
    results: versions.map((version) => {
      const runs = samples.get(version.label)!;
      return {
        version: version.label,
        medianMs: median(runs.map((run) => run.elapsedMs)),
        minMs: Math.min(...runs.map((run) => run.elapsedMs)),
        maxMs: Math.max(...runs.map((run) => run.elapsedMs)),
        medianPeakRssBytes: median(runs.map((run) => run.peakRssBytes)),
        samples: runs,
      };
    }),
  };
  trials.push(recorded);
  for (const result of recorded.results) {
    console.log(
      `  ${result.version}: ${result.medianMs.toFixed(3)} ms, ${(result.medianPeakRssBytes / 1048576).toFixed(2)} MiB peak`,
    );
  }
  return outputs;
}

async function compilerArtifact(ref: string | undefined, directory: string) {
  await mkdir(directory, { recursive: true });
  const modules = await Promise.all(
    ALL_COMPILER_TRIP_MODULE_NAMES.map(async (name) => {
      const path = compilerTripModuleSourcePath(name);
      return {
        name,
        source: ref
          ? git(
              "show",
              `${ref}:${relative(workspaceRoot, path).replaceAll("\\", "/")}`,
            ).toString()
          : await readFile(path, "utf8"),
      };
    }),
  );
  const bundle = serializeTripBundleV1({
    entryModule: "Compiler",
    target: { kind: "generic" },
    emitMainWrapper: true,
    modules,
  });
  const llPath = join(directory, "compiler.ll");
  const metadataPath = join(directory, "compiler-input.sha256");
  const bundleHash = sha256(bundle);
  const hostSourceSha256 = sourceHost.sha256;
  const cacheKey = `${bundleHash}:${executedHost.sha256}:${lockfileSha256 ?? "no-lockfile"}`;
  let llvm: string;
  try {
    assert.equal(await readFile(metadataPath, "utf8"), cacheKey);
    llvm = await readFile(llPath, "utf8");
  } catch {
    console.log(
      `Generating fixed compiler LLVM from ${ref ?? "candidate sources"}...`,
    );
    llvm = await compileTripSourceToLlvm(
      modules.find((module) => module.name === "Compiler")!.source,
      {
        entryModule: "Compiler",
        moduleSources: modules.filter((module) => module.name !== "Compiler"),
        emitMainWrapper: true,
      },
    );
    await writeFile(llPath, llvm);
    await writeFile(metadataPath, cacheKey);
  }
  await writeFile(join(directory, "compiler.bundle-v1"), bundle);
  return {
    llPath,
    bundle,
    llvmSha256: sha256(llvm),
    bundleSha256: bundleHash,
    hostSourceSha256,
  };
}

function compile(
  source: string,
  runtime: RuntimeVersion,
  output: string,
): void {
  capture(clang!, [
    source,
    join(runtime.directory, "trip_runtime.c"),
    ...flags,
    "-I",
    runtime.directory,
    "-o",
    output,
  ]);
}

await mkdir(workDir, { recursive: true });
const fixturePath = join(
  workspaceRoot,
  "scripts/fixtures/runtime-performance.c",
);
const monitorPath = join(
  workspaceRoot,
  "scripts/fixtures/performance-monitor.c",
);
const monitorExe = join(workDir, `performance-monitor${executableSuffix}`);
capture(clang, [
  monitorPath,
  ...flags,
  "-o",
  monitorExe,
  ...(process.platform === "win32" ? ["-lpsapi"] : []),
]);
const runtimes: RuntimeVersion[] = [];
for (const [label, ref] of [
  ["main", MAIN],
  ["prior-hardening", hardeningRef === "snapshot" ? "snapshot" : hardeningRef],
  ["candidate", undefined],
] as const) {
  const directory = join(workDir, label);
  await mkdir(directory, { recursive: true });
  const snapshotDirectory =
    ref === "snapshot"
      ? join(workspaceRoot, "scripts/fixtures/runtime-prior-hardening")
      : join(workspaceRoot, "runtime/trip");
  const source =
    ref && ref !== "snapshot"
      ? git("show", `${ref}:runtime/trip/trip_runtime.c`)
      : await readFile(join(snapshotDirectory, "trip_runtime.c"));
  const header =
    ref && ref !== "snapshot"
      ? git("show", `${ref}:runtime/trip/trip_runtime.h`)
      : await readFile(join(snapshotDirectory, "trip_runtime.h"));
  await writeFile(join(directory, "trip_runtime.c"), source);
  await writeFile(join(directory, "trip_runtime.h"), header);
  const version: RuntimeVersion = {
    label,
    revision:
      ref === "snapshot"
        ? HARDENING
        : ref
          ? git("rev-parse", ref).toString().trim()
          : "working-tree",
    sourceSha256: sha256(source),
    headerSha256: sha256(header),
    directory,
    fixtureExe: join(directory, `fixture${executableSuffix}`),
  };
  compile(fixturePath, version, version.fixtureExe);
  runtimes.push(version);
}
const fixedCompiler = skipBootstrap
  ? undefined
  : await compilerArtifact(sourceRef, join(workDir, "fixed-compiler"));
if (fixedCompiler) {
  for (const runtime of runtimes) {
    runtime.compilerExe = join(
      runtime.directory,
      `compiler${executableSuffix}`,
    );
    compile(fixedCompiler.llPath, runtime, runtime.compilerExe);
  }
}
let candidateCompiler: Awaited<ReturnType<typeof compilerArtifact>> | undefined;
let candidateCompilerExe: string | undefined;
if (fixedCompiler && !runtimeOnly) {
  candidateCompiler = await compilerArtifact(
    undefined,
    join(workDir, "candidate-compiler"),
  );
  candidateCompilerExe = join(workDir, `candidate-compiler${executableSuffix}`);
  compile(candidateCompiler.llPath, runtimes.at(-1)!, candidateCompilerExe);
}
if (argv.includes("--prepare-only")) {
  console.log(`Prepared benchmark artifacts in ${workDir}`);
  process.exit(0);
}

const input = Buffer.alloc(ioBytes);
let inputChecksum = 0;
for (let i = 0; i < ioBytes; i++) {
  input[i] = (i * 37 + 11) & 255;
  inputChecksum += input[i]!;
}
let allocationChecksum = 0;
for (let i = 0; i < allocationCount; i++)
  allocationChecksum += (i % 17) + [0, 1, 2, 3, 4, 8][i % 6]!;
let accessChecksum = 0;
for (let i = 0; i < accessCount; i++)
  accessChecksum += ((i % 1024) % 17) + (i % 1024) + (i % 4);
const fixtureVersions = runtimes.map((runtime) => ({
  label: runtime.label,
  exe: runtime.fixtureExe,
}));
if (!compilerOnly) {
  await trial(
    "small-allocation-footprint",
    fixtureVersions,
    ["allocate", "1024"],
    undefined,
    sha256(
      String(
        Array.from(
          { length: 1024 },
          (_, i) => (i % 17) + [0, 1, 2, 3, 4, 8][i % 6]!,
        ).reduce((a, b) => a + b, 0),
      ),
    ),
    repetitions,
    false,
  );
  await trial(
    "allocation",
    fixtureVersions,
    ["allocate", String(allocationCount)],
    undefined,
    sha256(String(allocationChecksum)),
    repetitions,
    false,
  );
  await trial(
    "object-access",
    fixtureVersions,
    ["access", String(accessCount)],
    undefined,
    sha256(String(accessChecksum)),
    repetitions,
    false,
  );
  await trial(
    "bulk-input-list",
    fixtureVersions,
    ["input-list", String(ioBytes)],
    input,
    sha256(String(inputChecksum)),
    repetitions,
    false,
  );
  await trial(
    "single-byte-input",
    fixtureVersions,
    ["input-byte", String(ioBytes)],
    input,
    sha256(String(inputChecksum)),
    repetitions,
    false,
  );
  await trial(
    "single-byte-output-default",
    fixtureVersions,
    ["output-byte", String(ioBytes)],
    undefined,
    sha256(input),
    repetitions,
    false,
  );
  await trial(
    "single-byte-output-buffered-opt-in",
    fixtureVersions,
    ["output-byte", String(ioBytes)],
    undefined,
    sha256(input),
    repetitions,
    true,
  );
}

if (fixedCompiler && !emissionOnly) {
  await trial(
    "fixed-LLVM-full-bootstrap-compile-default-output",
    runtimes.map((runtime) => ({
      label: runtime.label,
      exe: runtime.compilerExe!,
    })),
    [],
    fixedCompiler.bundle,
    undefined,
    compilerRepetitions,
    false,
  );
  await trial(
    "fixed-LLVM-full-bootstrap-compile-buffered-opt-in",
    runtimes.map((runtime) => ({
      label: runtime.label,
      exe: runtime.compilerExe!,
    })),
    [],
    fixedCompiler.bundle,
    undefined,
    compilerRepetitions,
    true,
  );
  const runtimeOutputs = trials
    .filter((item) => item.workload.startsWith("fixed-LLVM-"))
    .flatMap((item) =>
      item.results.map((result) => result.samples[0]!.outputSha256),
    );
  assert.equal(
    new Set(runtimeOutputs).size,
    1,
    "Fixed LLVM compiler disagrees across runtimes",
  );
}
let generatedCompilerCorrectness: unknown;
if (fixedCompiler && candidateCompiler && candidateCompilerExe) {
  const candidate = runtimes.at(-1)!;
  console.log(
    "Preparing predecessor and candidate Stage-2 compilers outside timed trials...",
  );
  const stage2Versions = [];
  const stage2Artifacts = [];
  for (const compiler of [
    {
      label: "predecessor-main-stage2-compiler",
      exe: candidate.compilerExe!,
      bundle: fixedCompiler.bundle,
    },
    {
      label: "candidate-stage2-compiler",
      exe: candidateCompilerExe,
      bundle: candidateCompiler.bundle,
    },
  ]) {
    const stage2Ll = execute(compiler.exe, [], compiler.bundle, true).output;
    const path = join(workDir, `${compiler.label}.ll`);
    const exe = join(workDir, `${compiler.label}${executableSuffix}`);
    await writeFile(path, stage2Ll);
    compile(path, candidate, exe);
    stage2Versions.push({ label: compiler.label, exe });
    stage2Artifacts.push({
      compiler: compiler.label,
      llvmSha256: sha256(stage2Ll),
      inputBundleSha256: sha256(compiler.bundle),
      executablePath: relative(workspaceRoot, exe).replaceAll("\\", "/"),
      executableSha256: sha256(await readFile(exe)),
    });
  }
  await trial(
    "stage2-compiler-emission-full-bootstrap-compile-default-output",
    stage2Versions,
    [],
    fixedCompiler.bundle,
    undefined,
    compilerRepetitions,
    false,
  );
  const outputs = await trial(
    "stage2-compiler-emission-full-bootstrap-compile-buffered-opt-in",
    stage2Versions,
    [],
    fixedCompiler.bundle,
    undefined,
    compilerRepetitions,
    true,
  );
  for (const [label, output] of outputs) {
    const defaultResult = trials
      .at(-2)!
      .results.find((result) => result.version === label)!;
    assert.equal(
      sha256(output),
      defaultResult.samples[0]!.outputSha256,
      `${label}: buffered output changed compiler IR`,
    );
  }
  const anchorBundle = serializeTripBundleV1({
    entryModule: "Main",
    target: { kind: "generic" },
    emitMainWrapper: true,
    modules: [
      {
        name: "Prelude",
        source: git("show", `${sourceRef}:lib/prelude.trip`).toString(),
      },
      {
        name: "Main",
        source:
          "module Main\nimport Prelude writeOne\nexport main\npoly main = writeOne #u8(65) [U8] (\\u : U8 => #u8(0))\n",
      },
    ],
  });
  const anchors = [];
  for (const [label, output] of outputs) {
    const llPath = join(workDir, `${label}.generated.ll`);
    const exePath = join(workDir, `${label}.generated${executableSuffix}`);
    await writeFile(llPath, output);
    compile(llPath, candidate, exePath);
    const anchorLl = execute(exePath, [], anchorBundle, true).output;
    const anchorPath = join(workDir, `${label}.anchor.ll`);
    const anchorExe = join(workDir, `${label}.anchor${executableSuffix}`);
    await writeFile(anchorPath, anchorLl);
    compile(anchorPath, candidate, anchorExe);
    const anchor = execute(anchorExe, [], undefined, false);
    assert.deepEqual(anchor.output, Buffer.from("A"));
    anchors.push({ compiler: label, outputSha256: anchor.sample.outputSha256 });
  }
  generatedCompilerCorrectness = {
    stage2Artifacts,
    inputSha256: sha256(anchorBundle),
    anchors,
  };
}

const report = {
  schemaVersion: 1,
  trial:
    "GPT-6.1 Sol Ultra performance trial against predecessor code revisions",
  recordedAt: new Date().toISOString(),
  scope:
    "Code-revision measurements on one machine; no intrinsic model ranking is established.",
  environment: {
    platform: platform(),
    arch: arch(),
    osRelease: release(),
    cpu: cpus()[0]?.model,
    logicalCpus: cpus().length,
    node: process.version,
    clang: capture(clang, ["--version"]).toString().trim(),
  },
  measurement: {
    timing:
      "Native monitor measures child process creation through termination, including runtime cleanup; one untimed warmup per version/workload, serial rotating run order.",
    peakMemory:
      process.platform === "win32"
        ? "GetProcessMemoryInfo.PeakWorkingSetSize after child termination"
        : "wait4.ru_maxrss (converted to bytes)",
    pointerValidation:
      "Default runtime build; TRIP_RUNTIME_VALIDATE_POINTERS is not defined",
    outputModes:
      "TRIP_RUNTIME_BUFFER_OUTPUT=0 for defaults; =1 for explicitly labeled buffered/full-compiler trials, set identically on all revisions",
  },
  command: ["node", "ts_out/scripts/runtimePerformance.js", ...argv],
  compilerFlags: flags,
  parameters: {
    allocationCount,
    accessCount,
    ioBytes,
    repetitions,
    compilerRepetitions,
  },
  fixtureSha256: sha256(await readFile(fixturePath)),
  monitorSha256: sha256(await readFile(monitorPath)),
  executionIdentity: startupIdentity,
  runtimes: runtimes.map(
    ({
      directory: _directory,
      fixtureExe: _fixtureExe,
      compilerExe: _compilerExe,
      ...metadata
    }) => metadata,
  ),
  compilerArtifacts: fixedCompiler
    ? {
        fixedSourceRevision: git("rev-parse", sourceRef).toString().trim(),
        fixedLlvmSha256: fixedCompiler.llvmSha256,
        fixedInputBundleSha256: fixedCompiler.bundleSha256,
        hostCompilerSourceSha256: fixedCompiler.hostSourceSha256,
        candidateLlvmSha256: candidateCompiler?.llvmSha256,
        candidateSourceBundleSha256: candidateCompiler?.bundleSha256,
      }
    : undefined,
  generatedCompilerCorrectness,
  trials,
};
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(`Saved verified results to ${outputPath}`);
