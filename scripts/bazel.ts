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
  | "ci"
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

const DENO = Deno.execPath();
const TEMP_ROOT = Deno.build.os === "windows"
  ? Deno.env.get("LOCALAPPDATA") ?? Deno.env.get("TEMP") ??
    Deno.env.get("TMP") ?? "."
  : Deno.env.get("TMPDIR") ?? "/tmp";
const DENO_DIR = Deno.env.get("TYPED_SKI_DENO_DIR") ??
  join(TEMP_ROOT, "typed-ski-deno-cache");
const COMPILED_TRIPC_NAME = Deno.build.os === "windows" ? "tripc.exe" : "tripc";
const BAZEL_RELEASE_WASM_FILENAMES = ["release.wasm", "release_wasm.wasm"];
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
  ci
  vs-project`);
  Deno.exit(1);
}

function getBazelWasmArtifactCandidates(): string[] {
  const candidates = BAZEL_RELEASE_WASM_FILENAMES.map((filename) =>
    join(PROJECT_ROOT, "bazel-bin", "wasm", filename)
  );

  try {
    for (const entry of Deno.readDirSync(join(PROJECT_ROOT, "bazel-out"))) {
      if (!entry.isDirectory) continue;
      for (const filename of BAZEL_RELEASE_WASM_FILENAMES) {
        candidates.push(
          join(PROJECT_ROOT, "bazel-out", entry.name, "bin", "wasm", filename),
        );
      }
    }
  } catch {
    // Ignore missing Bazel output roots and fall back to the default candidates.
  }

  return [...new Set(candidates)];
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

async function runCapture(
  args: string[],
  options: Deno.CommandOptions = {},
): Promise<string> {
  const { env: extraEnv, ...rest } = options;
  const command = new Deno.Command(
    args[0]!,
    {
      args: args.slice(1),
      cwd: PROJECT_ROOT,
      stdin: "null",
      stdout: "piped",
      stderr: "inherit",
      env: {
        ...Deno.env.toObject(),
        DENO_DIR,
        ...extraEnv,
      },
      ...rest,
    },
  );
  const { code, stdout } = await command.output();
  if (code !== 0) {
    throw new Error(`Command failed with exit code ${code}: ${args.join(" ")}`);
  }
  return new TextDecoder().decode(stdout).trim();
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
  await stageBazelWasmArtifactIfPresent();
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
  for (const candidate of getBazelWasmArtifactCandidates()) {
    try {
      const stat = Deno.statSync(candidate);
      if (stat.isFile) return toFileUrl(candidate).href;
    } catch {
      // Ignore missing Bazel outputs and fall through to the next candidate.
    }
  }
  return undefined;
}

async function stageBazelWasmArtifactIfPresent(): Promise<void> {
  const stagedPath = join(PROJECT_ROOT, "wasm", "release.wasm");
  for (const candidate of getBazelWasmArtifactCandidates()) {
    try {
      const stat = await Deno.stat(candidate);
      if (!stat.isFile) continue;
      await Deno.mkdir(join(PROJECT_ROOT, "wasm"), { recursive: true });
      const bytes = await Deno.readFile(candidate);
      await Deno.remove(stagedPath).catch(() => {});
      await Deno.writeFile(stagedPath, bytes);
      return;
    } catch {
      // Ignore missing Bazel outputs and fall through to the next candidate.
    }
  }
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
  await stageBazelWasmArtifactIfPresent();
  await buildDist();
  const wasmUrl = getBazelWasmArtifactUrl();
  const env: Record<string, string> = wasmUrl
    ? { TYPED_SKI_WASM_PATH: wasmUrl }
    : {};

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
  await stageBazelWasmArtifactIfPresent();
  await buildDist();
}

async function ci(): Promise<void> {
  verifyVersion();
  await syncGenerated();
  await stageBazelWasmArtifactIfPresent();
  await buildDist();
  await formatCheck();
  await lint();

  const wasmUrl = getBazelWasmArtifactUrl();
  const env: Record<string, string> = wasmUrl
    ? { TYPED_SKI_WASM_PATH: wasmUrl }
    : {};

  const files = await collectPortableTests();
  await run(denoTestArgs(files), { env });

  await Deno.remove(join(PROJECT_ROOT, "coverage"), { recursive: true }).catch(
    () => {},
  );
  await run(denoTestArgs(files, { coverage: "coverage" }), { env });
  await run([DENO, "coverage", "coverage", "--lcov", "--output=coverage.lcov"]);
}

function escapeForJsonPath(value: string): string {
  return value.replaceAll("/", "\\");
}

function toWorkspaceOrAbsolutePath(path: string): string {
  const rel = relative(PROJECT_ROOT, path);
  if (!rel.startsWith("..") && rel !== "") {
    return "${workspaceRoot}\\" + escapeForJsonPath(rel);
  }
  if (path === PROJECT_ROOT) {
    return "${workspaceRoot}";
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

async function collectCoreFiles(): Promise<{ sources: string[]; headers: string[] }> {
  const coreDir = join(PROJECT_ROOT, "core");
  const sources: string[] = [];
  const headers: string[] = [];

  for await (const entry of Deno.readDir(coreDir)) {
    if (!entry.isFile) continue;
    if (entry.name.endsWith(".c")) {
      sources.push(`core\\${entry.name}`);
    } else if (entry.name.endsWith(".h")) {
      headers.push(`core\\${entry.name}`);
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
      "core\\arena.c",
      "core\\host_platform_windows.c",
      "core\\main.c",
      "core\\session.c",
      "core\\ski_io.c",
      "core\\thanatos.c",
      "core\\util.c",
    ],
  },
  {
    bazelLabel: "//core:dag_codec_test",
    projectName: "typed-ski-dag-codec-test",
    projectFileBase: "typed-ski-dag-codec-test",
    outputName: "dag_codec_test.exe",
    sourceFiles: [
      "core\\arena.c",
      "core\\dag_codec_test.c",
      "core\\host_platform_windows.c",
      "core\\ski_io.c",
      "core\\util.c",
    ],
  },
  {
    bazelLabel: "//core:session_test",
    projectName: "typed-ski-session-test",
    projectFileBase: "typed-ski-session-test",
    outputName: "session_test.exe",
    sourceFiles: [
      "core\\arena.c",
      "core\\host_platform_windows.c",
      "core\\session.c",
      "core\\session_test.c",
      "core\\ski_io.c",
      "core\\thanatos.c",
      "core\\util.c",
    ],
  },
  {
    bazelLabel: "//core:performance_test",
    projectName: "typed-ski-performance-test",
    projectFileBase: "typed-ski-performance-test",
    outputName: "performance_test.exe",
    debuggerArgs: "8 67108864 256 5 4294967295",
    sourceFiles: [
      "core\\arena.c",
      "core\\host_platform_windows.c",
      "core\\performance_test.c",
      "core\\session.c",
      "core\\ski_io.c",
      "core\\thanatos.c",
      "core\\util.c",
    ],
  },
  {
    bazelLabel: "//core:ski_io_test",
    projectName: "typed-ski-ski-io-test",
    projectFileBase: "typed-ski-ski-io-test",
    outputName: "ski_io_test.exe",
    sourceFiles: [
      "core\\arena.c",
      "core\\host_platform_windows.c",
      "core\\session.c",
      "core\\ski_io.c",
      "core\\ski_io_test.c",
      "core\\thanatos.c",
      "core\\util.c",
    ],
  },
  {
    bazelLabel: "//core:util_test",
    projectName: "typed-ski-util-test",
    projectFileBase: "typed-ski-util-test",
    outputName: "util_test.exe",
    sourceFiles: [
      "core\\util.c",
      "core\\util_test.c",
    ],
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
  const rebuildCommand =
    `cmd /c "bazelisk clean && bazelisk build ${target.bazelLabel}"`;
  const cleanCommand = "bazelisk clean";
  const sourceItems = target.sourceFiles.map((file) =>
    `    <ClCompile Include="${xmlEscape(file)}" />`
  ).join("\n");
  const headerItems = headers.map((file) => `    <ClInclude Include="${xmlEscape(file)}" />`).join("\n");
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

function buildVcxprojFilters(target: VisualStudioNativeTarget, headers: string[]): string {
  const sourceItems = target.sourceFiles.map((file) =>
    `    <ClCompile Include="${xmlEscape(file)}"><Filter>Source Files</Filter></ClCompile>`
  ).join("\n");
  const headerItems = headers.map((file) =>
    `    <ClInclude Include="${xmlEscape(file)}"><Filter>Header Files</Filter></ClInclude>`
  ).join("\n");

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
  projects: Array<{ projectName: string; projectFileBase: string; projectGuid: string }>,
): string {
  const projectEntries = projects.map((project) =>
    `Project("{BC8A1FFA-BEE3-4634-8014-F334798102B3}") = "${project.projectName}", "${project.projectFileBase}.vcxproj", "${project.projectGuid}"
EndProject`
  ).join("\n");
  const projectConfigs = projects.map((project) =>
    `\t\t${project.projectGuid}.Debug|x64.ActiveCfg = Debug|x64
\t\t${project.projectGuid}.Debug|x64.Build.0 = Debug|x64
\t\t${project.projectGuid}.Release|x64.ActiveCfg = Release|x64
\t\t${project.projectGuid}.Release|x64.Build.0 = Release|x64`
  ).join("\n");

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
  const bazel = Deno.build.os === "windows" ? "bazelisk.exe" : "bazelisk";
  const executionRoot = await runCapture([bazel, "info", "execution_root"]);
  const bazelBin = await runCapture([bazel, "info", "bazel-bin"]);
  const aqueryOutput = await runCapture([
    bazel,
    "aquery",
    "mnemonic('CppCompile', //core:all)",
    "--output=jsonproto",
  ]);
  const aquery = JSON.parse(aqueryOutput) as AqueryResponse;
  const vcxprojTemplate = await Deno.readTextFile(
    join(PROJECT_ROOT, "scripts", "templates", "vcxproj.xml.tpl"),
  );
  const { headers } = await collectCoreFiles();

  const targets = new Map<number, AqueryTarget>(
    (aquery.targets ?? []).map((target) => [target.id, target]),
  );

  function resolveActionPath(path: string): string {
    if (/^[A-Za-z]:[\\/]/.test(path) || path.startsWith("/")) {
      return path;
    }
    if (path === "." || path === "") {
      return PROJECT_ROOT;
    }
    if (path.startsWith("external/")) {
      return join(executionRoot, path);
    }
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

      if ((arg === "-I" || arg === "-isystem" || arg === "-iquote" ||
        arg === "/I") && index + 1 < args.length) {
        includeDirs.push(resolveActionPath(args[index + 1]!));
        index += 1;
        continue;
      }

      if ((arg.startsWith("-I") || arg.startsWith("-isystem") ||
        arg.startsWith("-iquote")) &&
        !["-I", "-isystem", "-iquote"].includes(arg)) {
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
    configurations: [{
      name: "Bazel-x64-Debug",
      includePath: dedupe([
        "${workspaceRoot}\\**",
        ...includeDirs.map(toWorkspaceOrAbsolutePath),
      ]),
      defines: dedupe(defines),
      intelliSenseMode: "windows-clang-x64",
      compilerPath: compilerPath ? toWorkspaceOrAbsolutePath(compilerPath) : undefined,
    }],
  };

  const tasksVs = {
    version: "0.2.1",
    tasks: [
      {
        taskLabel: "bazel build thanatos",
        appliesTo: "/",
        type: "default",
        command: bazel,
        args: ["build", "//:thanatos"],
      },
      {
        taskLabel: "bazel test native_tests",
        appliesTo: "/",
        type: "default",
        command: bazel,
        args: ["test", "//:native_tests"],
      },
      {
        taskLabel: "bazel refresh Visual Studio metadata",
        appliesTo: "/",
        type: "default",
        command: bazel,
        args: ["run", "//:vs_project"],
      },
    ],
  };

  const thanatosExe = join(
    bazelBin,
    "core",
    Deno.build.os === "windows" ? "thanatos.exe" : "thanatos",
  );
  const slnPath = join(PROJECT_ROOT, "typed-ski-native.sln");
  const launchVs = {
    version: "0.2.1",
    defaults: {},
    configurations: [{
      type: "cppdbg",
      name: "thanatos (Bazel)",
      project: toWorkspaceOrAbsolutePath(thanatosExe),
      cwd: "${workspaceRoot}",
      program: toWorkspaceOrAbsolutePath(thanatosExe),
      MIMode: "gdb",
      externalConsole: true,
    }],
  };

  const cleanCppProperties = JSON.parse(JSON.stringify(cppProperties));
  await Deno.mkdir(join(PROJECT_ROOT, ".vs"), { recursive: true });
  await Deno.writeTextFile(
    join(PROJECT_ROOT, "compile_commands.json"),
    JSON.stringify(normalizedCompileCommands, null, 2) + "\n",
  );
  await Deno.writeTextFile(
    join(PROJECT_ROOT, "CppProperties.json"),
    JSON.stringify(cleanCppProperties, null, 2) + "\n",
  );
  await Deno.writeTextFile(
    join(PROJECT_ROOT, ".vs", "tasks.vs.json"),
    JSON.stringify(tasksVs, null, 2) + "\n",
  );
  await Deno.writeTextFile(
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
    const outputPath = join(
      bazelBin,
      "core",
      target.outputName,
    );
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

    await Deno.writeTextFile(vcxprojPath, vcxprojContent);
    await Deno.writeTextFile(
      vcxprojFiltersPath,
      buildVcxprojFilters(target, headers),
    );

    solutionProjects.push({
      projectName: target.projectName,
      projectFileBase: target.projectFileBase,
      projectGuid,
    });
  }
  await Deno.writeTextFile(
    slnPath,
    buildSolution(solutionProjects),
  );

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
  console.log("Open the repo with Visual Studio's Open Folder workflow or the generated .sln.");
  console.log(
    "If gdb.exe is not on PATH, edit .vs/launch.vs.json and set miDebuggerPath.",
  );
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
  case "vs-project":
    await generateVisualStudioProject();
    break;
  default:
    usage();
}
