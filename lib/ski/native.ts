/**
 * Native evaluation of SKI expressions with numeric optimization.
 *
 * This module provides a native evaluator for SKI expressions that includes
 * optimized handling of numeric operations and Church numeral evaluation.
 *
 * @module
 */
import type { SKITerminalSymbol } from "./terminal.ts";
import type { SKIExpression } from "./expression.ts";

/**
 * A terminal symbol (S, K, I) in the native representation
 */
export interface NativeTerminal {
  kind: "terminal";
  sym: SKITerminalSymbol;
}

/**
 * A numeric literal in the native representation
 */
export interface NativeNum {
  kind: "num";
  value: bigint;
}

/**
 * The increment operation in the native representation
 */
export interface NativeInc {
  kind: "inc";
}

/**
 * An application in the native representation
 */
export interface NativeApplication {
  kind: "non-terminal";
  lft: NativeExpr;
  rgt: NativeExpr;
}

/**
 * The legal terms of the native representation.
 * This includes:
 * - Terminal symbols (S, K, I)
 * - Numeric literals
 * - The increment operation
 * - Applications
 */
export type NativeExpr =
  | NativeTerminal
  | NativeNum
  | NativeInc
  | NativeApplication;

/**
 * Creates a numeric literal with the given value
 */
export const mkNativeNum = (k: number | bigint = 0n): NativeNum => ({
  kind: "num",
  value: typeof k === "bigint" ? k : BigInt(k),
});

/**
 * The increment operation
 */
export const mkNativeInc = (): NativeInc => ({ kind: "inc" });

/**
 * Creates a terminal symbol node
 */
export const mkNativeTerminal = (sym: SKITerminalSymbol): NativeTerminal => ({
  kind: "terminal",
  sym,
});

const skiToNative = (ski: SKIExpression): NativeExpr =>
  ski.kind === "terminal" ? mkNativeTerminal(ski.sym) : {
    kind: "non-terminal",
    lft: skiToNative(ski.lft),
    rgt: skiToNative(ski.rgt),
  };

interface NativeStepResult {
  altered: boolean;
  expr: NativeExpr;
}

const stepNative = (e: NativeExpr): NativeStepResult => {
  switch (e.kind) {
    case "terminal":
    case "num":
    case "inc":
      // No reduction possible for atomic expressions
      return { altered: false, expr: e };

    case "non-terminal": {
      // Handle (INC (NUM k)) -> NUM (k+1)
      if (e.lft.kind === "inc" && e.rgt.kind === "num") {
        return { altered: true, expr: mkNativeNum(e.rgt.value + 1n) };
      }

      // Handle SKI reduction rules
      // I x -> x
      if (e.lft.kind === "terminal" && e.lft.sym === "I") {
        return { altered: true, expr: e.rgt };
      }

      // K x y -> x
      if (
        e.lft.kind === "non-terminal" &&
        e.lft.lft.kind === "terminal" &&
        e.lft.lft.sym === "K"
      ) {
        return { altered: true, expr: e.lft.rgt };
      }

      // S x y z -> (x z) (y z)
      if (
        e.lft.kind === "non-terminal" &&
        e.lft.lft.kind === "non-terminal" &&
        e.lft.lft.lft.kind === "terminal" &&
        e.lft.lft.lft.sym === "S"
      ) {
        const x = e.lft.lft.rgt;
        const y = e.lft.rgt;
        const z = e.rgt;
        return {
          altered: true,
          expr: {
            kind: "non-terminal",
            lft: { kind: "non-terminal", lft: x, rgt: z },
            rgt: { kind: "non-terminal", lft: y, rgt: z },
          },
        };
      }

      // Recurse on left subtree
      const leftStep = stepNative(e.lft);
      if (leftStep.altered) {
        return {
          altered: true,
          expr: {
            kind: "non-terminal",
            lft: leftStep.expr,
            rgt: e.rgt,
          },
        };
      }

      // Recurse on right subtree
      const rightStep = stepNative(e.rgt);
      if (rightStep.altered) {
        return {
          altered: true,
          expr: {
            kind: "non-terminal",
            lft: e.lft,
            rgt: rightStep.expr,
          },
        };
      }

      // No reduction possible
      return { altered: false, expr: e };
    }
  }
};

export const stepOnceNat = (e: NativeExpr): NativeStepResult => {
  return stepNative(e);
};

export const reduceNat = (root: NativeExpr): NativeExpr => {
  let cur: NativeExpr = root;
  for (;;) {
    const r = stepOnceNat(cur);
    if (!r.altered) return cur;
    cur = r.expr;
  }
};

export const unChurchNumber = (church: SKIExpression): bigint => {
  /* build  (church  INC  (NUM 0)) in the new ADT */
  const natTerm: NativeExpr = reduceNat(
    {
      kind: "non-terminal",
      lft: {
        kind: "non-terminal",
        lft: skiToNative(church),
        rgt: mkNativeInc(),
      },
      rgt: mkNativeNum(0n),
    },
  );

  if (natTerm.kind === "num") return natTerm.value;
  return 0n;
};
