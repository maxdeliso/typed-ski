import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { workspaceRoot } from "../lib/shared/workspaceRoot.ts";
import { compileMiniCoreModules } from "../lib/minicore/fromTrip.ts";
import {
  evaluateMiniCore,
  valueToNat,
  type MiniCoreTelemetry,
} from "../lib/minicore/evaluator.ts";
import type { Program } from "../lib/minicore/ast.ts";
import type { AvlCase } from "./avlCases.ts";

export interface AvlMiniCoreRunResult {
  actual: bigint;
  compileMs: number;
  evalMs: number;
  telemetry: MiniCoreTelemetry;
  program: Program;
}

const PRELUDE_SOURCE_FILE = join(workspaceRoot, "lib", "prelude.trip");
const BIN_SOURCE_FILE = join(workspaceRoot, "lib", "bin.trip");
const NAT_SOURCE_FILE = join(workspaceRoot, "lib", "nat.trip");
const AVL_SOURCE_FILE = join(workspaceRoot, "lib", "avl.trip");

let builtinSourcesPromise:
  | Promise<{
      prelude: string;
      bin: string;
      nat: string;
      avl: string;
    }>
  | undefined;

async function getBuiltinSources(): Promise<{
  prelude: string;
  bin: string;
  nat: string;
  avl: string;
}> {
  return (builtinSourcesPromise ??= Promise.all([
    readFile(PRELUDE_SOURCE_FILE, "utf8"),
    readFile(BIN_SOURCE_FILE, "utf8"),
    readFile(NAT_SOURCE_FILE, "utf8"),
    readFile(AVL_SOURCE_FILE, "utf8"),
  ]).then(([prelude, bin, nat, avl]) => ({ prelude, bin, nat, avl })));
}

export async function buildAvlMiniCoreProgram(
  source: string,
  moduleName: string,
): Promise<{ program: Program; compileMs: number }> {
  const builtins = await getBuiltinSources();
  const start = performance.now();
  const program = compileMiniCoreModules(
    [
      { name: "Prelude", source: builtins.prelude },
      { name: "Bin", source: builtins.bin },
      { name: "Nat", source: builtins.nat },
      { name: "Avl", source: builtins.avl },
      { name: moduleName, source },
    ],
    moduleName,
  );
  return { program, compileMs: performance.now() - start };
}

export async function runAvlMiniCoreCase(
  testCase: AvlCase,
): Promise<AvlMiniCoreRunResult> {
  const source = await testCase.loadSource();
  const { program, compileMs } = await buildAvlMiniCoreProgram(
    source,
    testCase.moduleName,
  );
  const evalStart = performance.now();
  const result = evaluateMiniCore(program);
  const evalMs = performance.now() - evalStart;
  return {
    actual: valueToNat(result.value),
    compileMs,
    evalMs,
    telemetry: result.telemetry,
    program,
  };
}
