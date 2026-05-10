import { compileToObjectFile } from "../../lib/compiler/singleFileCompiler.ts";
import { linkModules } from "../../lib/linker/moduleLinker.ts";
import { parseSKI } from "../../lib/parser/ski.ts";
import { getPreludeObject } from "../../lib/prelude.ts";
import { getNatObject } from "../../lib/nat.ts";
import { getBinObject } from "../../lib/bin.ts";
import type { SKIExpression } from "../../lib/ski/expression.ts";
import type { ThanatosEvaluator } from "../../lib/index.ts";

interface TripHarnessOptions {
  includePrelude?: boolean;
  includeNat?: boolean;
  includeBin?: boolean;
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
  return linkModules(modules);
}

export async function evaluateTrip(
  source: string,
  evaluator: ThanatosEvaluator,
  options: TripHarnessOptions = {},
): Promise<SKIExpression> {
  const skiExpression = await compileAndLink(source, options);
  const skiExpr = parseSKI(skiExpression);
  return await evaluator.reduce(skiExpr);
}

export async function evaluateTripWithIo(
  source: string,
  evaluator: ThanatosEvaluator,
  options: TripIoOptions = {},
): Promise<TripIoResult> {
  const verbose = options.verbose ?? false;
  const skiExpression = await compileAndLink(source, options, verbose);
  const skiExpr = parseSKI(skiExpression);
  const { result, stdout } = await evaluator.reduceWithIo(
    skiExpr,
    options.stdin ?? new Uint8Array(0),
  );
  if (options.stepLimit !== undefined) {
    return {
      result: await evaluator.reduce(skiExpr, options.stepLimit),
      stdout,
    };
  }
  return { result, stdout };
}
