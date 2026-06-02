import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workspaceRoot } from "../../../lib/shared/workspaceRoot.ts";
import {
  compilerTripModuleSourcePath,
  isKnownCompilerTripModule,
  type CompilerTripModuleName,
} from "../../../lib/compiler/bootstrapModules.ts";
import {
  compileTripSourceToLlvm,
  type CompileTripSourceToLlvmOptions,
} from "../../../lib/compiler/index.ts";

const PROJECT_ROOT = workspaceRoot;

export interface RunResult {
  stdout: string;
  stderr: string;
  status: number | null;
}

export interface HarnessOptions extends CompileTripSourceToLlvmOptions {
  cleanup?: boolean;
  runtimeSources?: string[];
  stdin?: string | Uint8Array;
}

const CLANG = process.env["TYPED_SKI_CLANG"];

function macosSdkArgs(): string[] {
  if (process.platform !== "darwin") {
    return [];
  }

  const configuredSdk = process.env["SDKROOT"];
  if (configuredSdk) {
    return ["-isysroot", configuredSdk];
  }

  const xcrun = spawnSync("xcrun", ["--show-sdk-path"], { encoding: "utf8" });
  if (xcrun.status !== 0) {
    throw new Error(
      `xcrun --show-sdk-path failed:\nstdout: ${xcrun.stdout}\nstderr: ${xcrun.stderr}`,
    );
  }

  return ["-isysroot", xcrun.stdout.trim()];
}

/**
 * Compiles Trip source to LLVM IR using the host (TypeScript) compiler.
 */
export async function compileTripToLlvm(
  source: string,
  options: CompileTripSourceToLlvmOptions,
): Promise<string> {
  return compileTripSourceToLlvm(source, options);
}

/**
 * Compiles LLVM IR to a native executable using Clang.
 */
export async function compileLlvmToExecutable(
  llPath: string,
  runtimeSources: string[] = [],
): Promise<string> {
  if (!CLANG) {
    throw new Error(
      "TYPED_SKI_CLANG environment variable is not set. Ensure you are running through a Bazel rule that provides it.",
    );
  }

  const exePath = llPath.replace(
    /\.ll$/,
    process.platform === "win32" ? ".exe" : "",
  );
  const allRuntimeSources =
    runtimeSources.length > 0
      ? runtimeSources
      : [join(PROJECT_ROOT, "runtime/trip/trip_runtime.c")];

  const args = [
    llPath,
    ...allRuntimeSources,
    "-I",
    join(PROJECT_ROOT, "runtime/trip"),
    ...macosSdkArgs(),
    "-o",
    exePath,
    ...(process.platform !== "win32"
      ? ["-lm", "-lpthread", "-D_POSIX_C_SOURCE=200809L", "-D_GNU_SOURCE"]
      : []),
  ];

  const result = spawnSync(CLANG, args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(
      `Clang failed:\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
    );
  }

  return exePath;
}

/**
 * Runs a native executable and returns its output.
 */
export function runExecutable(
  exePath: string,
  input?: string | Uint8Array,
): RunResult {
  const result = spawnSync(exePath, [], {
    input,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    status: result.status,
  };
}

/**
 * Orchestrates compiling Trip source and running the resulting executable.
 */
export async function compileTripAndRun(
  source: string,
  options: HarnessOptions = {},
): Promise<RunResult> {
  const tempDir = await mkdtemp(join(tmpdir(), "trip-llvm-test-"));
  try {
    const llvm = await compileTripToLlvm(source, {
      ...options,
      emitMainWrapper: options.emitMainWrapper ?? true,
    });
    const llPath = join(tempDir, "main.ll");
    await writeFile(llPath, llvm, "utf8");

    const exePath = await compileLlvmToExecutable(
      llPath,
      options.runtimeSources,
    );
    return runExecutable(exePath, options.stdin);
  } finally {
    if (options.cleanup !== false) {
      await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

/**
 * Bootstrapped execution mode helpers.
 */
export const bootstrap = {
  /**
   * Compiles the Trip compiler itself to a native executable.
   */
  async compileCompilerToNative(): Promise<{
    exePath: string;
    cleanup: () => Promise<void>;
  }> {
    const tempDir = await mkdtemp(join(tmpdir(), "trip-compiler-bootstrap-"));
    const cleanup = () => rm(tempDir, { recursive: true, force: true });

    try {
      const moduleNames: readonly CompilerTripModuleName[] = [
        "Prelude",
        "Nat",
        "Bin",
        "BundleSummary",
        "Avl",
        "Lexer",
        "Parser",
        "Core",
        "DataEnv",
        "CoreToLower",
        "Unparse",
        "Lowering",
        "Bridge",
        "Llvm",
        "CoreToMini",
        "MiniCore",
        "Anf",
        "AnfLlvm",
      ];
      const moduleSources = await Promise.all(
        moduleNames.map(async (name) => ({
          name,
          source: await readFile(compilerTripModuleSourcePath(name), "utf8"),
        })),
      );

      const compilerSource = await readFile(
        compilerTripModuleSourcePath("Compiler"),
        "utf8",
      );

      const llvm = await compileTripToLlvm(compilerSource, {
        entryModule: "Compiler",
        moduleSources,
        emitMainWrapper: true,
      });

      const llPath = join(tempDir, "compiler.ll");
      await writeFile(llPath, llvm, "utf8");

      const exePath = await compileLlvmToExecutable(llPath);
      return { exePath, cleanup };
    } catch (e) {
      await cleanup();
      throw e;
    }
  },

  /**
   * Runs the native compiler on a fixture to produce stage-1 LLVM.
   */
  async runNativeCompiler(
    compilerExePath: string,
    fixtureSource: string | Uint8Array,
  ): Promise<string> {
    const result = runExecutable(compilerExePath, fixtureSource);
    if (result.status !== 0) {
      throw new Error(
        `Native compiler failed:\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
      );
    }
    return result.stdout;
  },
};

/**
 * Loads common library modules for testing.
 */
export async function loadCommonModules(
  names: string[],
): Promise<Array<{ name: string; source: string }>> {
  return Promise.all(
    names.map(async (name) => {
      if (!isKnownCompilerTripModule(name)) {
        throw new Error(`loadCommonModules: unknown module '${name}'`);
      }
      return {
        name,
        source: await readFile(compilerTripModuleSourcePath(name), "utf8"),
      };
    }),
  );
}
