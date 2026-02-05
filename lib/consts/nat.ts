/**
 * Shared constants for natural number literals.
 */
export * from "./natNames.ts";
import {
  createApplication,
  mkUntypedAbs,
  mkVar,
  type UntypedLambda,
} from "../terms/lambda.ts";
import type { SKIExpression } from "../ski/expression.ts";
import { ChurchN } from "../ski/church.ts";
import { SKITerminalSymbol } from "../ski/terminal.ts";

const lambdaS = mkUntypedAbs(
  "x",
  mkUntypedAbs(
    "y",
    mkUntypedAbs(
      "z",
      createApplication(
        createApplication(mkVar("x"), mkVar("z")),
        createApplication(mkVar("y"), mkVar("z")),
      ),
    ),
  ),
);

const lambdaK = mkUntypedAbs(
  "x",
  mkUntypedAbs("y", mkVar("x")),
);

const lambdaI = mkUntypedAbs("x", mkVar("x"));

const terminalToLambda = (sym: SKITerminalSymbol): UntypedLambda => {
  switch (sym) {
    case SKITerminalSymbol.S:
      return lambdaS;
    case SKITerminalSymbol.K:
      return lambdaK;
    case SKITerminalSymbol.I:
      return lambdaI;
    default:
      throw new Error(`Unknown SKI terminal: ${sym}`);
  }
};

const skiToUntyped = (expr: SKIExpression): UntypedLambda => {
  if (expr.kind === "terminal") {
    return terminalToLambda(expr.sym);
  }
  return createApplication(
    skiToUntyped(expr.lft),
    skiToUntyped(expr.rgt),
  );
};

export const makeUntypedChurchNumeral = (value: bigint): UntypedLambda => {
  if (value < 0n) {
    throw new RangeError("Nat literals must be non-negative");
  }
  const skiExpr = ChurchN(value);
  return skiToUntyped(skiExpr);
};

export const makeUntypedBinNumeral = (value: bigint): UntypedLambda => {
  if (value < 0n) {
    throw new RangeError("Nat literals must be non-negative");
  }
  if (value === 0n) {
    return mkVar("BZ");
  }
  const bits: number[] = [];
  let n = value;
  while (n > 0n) {
    bits.push(Number(n & 1n));
    n = n / 2n;
  }
  let term: UntypedLambda = mkVar("BZ");
  for (let i = bits.length - 1; i >= 0; i--) {
    const ctor = bits[i] === 0 ? "B0" : "B1";
    term = createApplication(mkVar(ctor), term);
  }
  return term;
};
