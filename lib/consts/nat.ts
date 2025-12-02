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
