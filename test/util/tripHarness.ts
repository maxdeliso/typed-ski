import { compileToObjectFile } from "../../lib/compiler/singleFileCompiler.ts";
import { linkModules } from "../../lib/linker/moduleLinker.ts";
import { parseSKI } from "../../lib/parser/ski.ts";
import { getPreludeObject } from "../../lib/prelude.ts";
import { getNatObject } from "../../lib/nat.ts";
import type { SKIExpression } from "../../lib/ski/expression.ts";
import { arenaEvaluator } from "../../lib/evaluator/skiEvaluator.ts";
import { ParallelArenaEvaluatorWasm } from "../../lib/evaluator/parallelArenaEvaluator.ts";

export interface TripHarnessOptions {
  includePrelude?: boolean;
  includeNat?: boolean;
}

export interface TripIoOptions extends TripHarnessOptions {
  stdin?: Uint8Array;
  stdoutMaxBytes?: number;
  stepLimit?: number;
}

export interface TripIoResult {
  result: SKIExpression;
  stdout: Uint8Array;
}

export async function compileAndLink(
  source: string,
  options: TripHarnessOptions = {},
): Promise<string> {
  const includePrelude = options.includePrelude ?? true;
  const includeNat = options.includeNat ?? false;
  const moduleObject = compileToObjectFile(source);
  const modules = includePrelude
    ? [{ name: "Prelude", object: await getPreludeObject() }]
    : [];

  if (includeNat) {
    modules.push({ name: "Nat", object: await getNatObject() });
  }

  modules.push({ name: moduleObject.module, object: moduleObject });
  return linkModules(modules, true);
}

export async function evaluateTrip(
  source: string,
  options: TripHarnessOptions = {},
): Promise<SKIExpression> {
  const skiExpression = await compileAndLink(source, options);
  const skiExpr = parseSKI(skiExpression);
  return arenaEvaluator.reduce(skiExpr);
}

export async function evaluateTripWithIo(
  source: string,
  options: TripIoOptions = {},
): Promise<TripIoResult> {
  const skiExpression = await compileAndLink(source, options);
  const skiExpr = parseSKI(skiExpression);
  const evaluator = await ParallelArenaEvaluatorWasm.create(1);

  try {
    const resultPromise = evaluator.reduceAsync(skiExpr, options.stepLimit);
    if (options.stdin && options.stdin.length > 0) {
      await evaluator.writeStdin(options.stdin);
    }
    const result = await resultPromise;
    const stdout = evaluator.readStdout(options.stdoutMaxBytes ?? 4096);
    return { result, stdout };
  } finally {
    evaluator.terminate();
  }
}
