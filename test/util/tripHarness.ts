import { compileToObjectFile } from "../../lib/compiler/singleFileCompiler.ts";
import { linkModules } from "../../lib/linker/moduleLinker.ts";
import { parseSKI } from "../../lib/parser/ski.ts";
import { getPreludeObject } from "../../lib/prelude.ts";
import { getNatObject } from "../../lib/nat.ts";
import { getBinObject } from "../../lib/bin.ts";
import type { SKIExpression } from "../../lib/ski/expression.ts";
import { arenaEvaluator } from "../../lib/evaluator/skiEvaluator.ts";
import { ParallelArenaEvaluatorWasm } from "../../lib/evaluator/parallelArenaEvaluator.ts";
import type { Evaluator } from "../../lib/evaluator/evaluator.ts";

interface TripHarnessOptions {
  includePrelude?: boolean;
  includeNat?: boolean;
  includeBin?: boolean;
  evaluator?: Evaluator;
}

interface TripIoOptions extends TripHarnessOptions {
  stdin?: Uint8Array;
  stdoutMaxBytes?: number;
  stepLimit?: number;
  verbose?: boolean;
}

interface TripIoResult {
  result: SKIExpression;
  stdout: Uint8Array;
  evaluator: Evaluator;
}

async function compileAndLink(
  source: string,
  options: TripHarnessOptions = {},
  verbose = false,
): Promise<string> {
  const includePrelude = options.includePrelude ?? true;
  const includeNat = options.includeNat ?? false;
  const includeBin = options.includeBin ?? false;
  const moduleObject = compileToObjectFile(source);
  const modules = includePrelude
    ? [{ name: "Prelude", object: await getPreludeObject() }]
    : [];

  if (includeBin) {
    modules.push({ name: "Bin", object: await getBinObject() });
  }

  if (includeNat) {
    modules.push({ name: "Nat", object: await getNatObject() });
  }

  modules.push({ name: moduleObject.module, object: moduleObject });
  return linkModules(modules, verbose);
}

export async function evaluateTrip(
  source: string,
  options: TripHarnessOptions = {},
): Promise<SKIExpression> {
  const skiExpression = await compileAndLink(source, options);
  const skiExpr = parseSKI(skiExpression);
  const evalToUse = options.evaluator ?? arenaEvaluator;
  if (evalToUse.reduceAsync) {
    return await evalToUse.reduceAsync(skiExpr);
  }
  return evalToUse.reduce(skiExpr);
}

export async function evaluateTripWithIo(
  source: string,
  options: TripIoOptions = {},
): Promise<TripIoResult> {
  const verbose = options.verbose ?? false;
  const skiExpression = await compileAndLink(source, options, verbose);
  const skiExpr = parseSKI(skiExpression);
  const evaluator = await ParallelArenaEvaluatorWasm.create(1, verbose);

  try {
    const resultPromise = evaluator.reduceAsync!(skiExpr, options.stepLimit);
    if (options.stdin && options.stdin.length > 0) {
      await evaluator.writeStdin(options.stdin);
    }
    const result = await resultPromise;
    const stdout = await evaluator.readStdout(options.stdoutMaxBytes ?? 4096);
    return { result, stdout, evaluator };
  } catch (err) {
    evaluator.terminate();
    throw err;
  }
  // Note: Caller is responsible for terminating evaluator in TripIoResult
}
