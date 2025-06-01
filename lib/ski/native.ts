import { SKITerminalSymbol } from "./terminal.ts";
import { SKIExpression } from "./expression.ts";
import { cons, ConsCell } from "../cons.ts";

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
  value: number;
}

/**
 * The increment operation in the native representation
 */
export interface NativeInc {
  kind: "inc";
}

/**
 * The legal terms of the native representation.
 * This includes:
 * - Terminal symbols (S, K, I)
 * - Numeric literals
 * - The increment operation
 * - Applications (represented as cons cells)
 */
export type NativeExpr =
  | NativeTerminal
  | NativeNum
  | NativeInc
  | ConsCell<NativeExpr>;

/**
 * Creates a numeric literal with the given value
 */
export const mkNativeNum = (k = 0): NativeNum => ({ kind: "num", value: k });

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
  ski.kind === "terminal"
    ? mkNativeTerminal(ski.sym)
    : cons(skiToNative(ski.lft), skiToNative(ski.rgt));

interface NativeStepResult {
  altered: boolean;
  expr: NativeExpr;
}

const stepNative = (e: NativeExpr): NativeStepResult => {
  // Handle (INC (NUM k)) -> NUM (k+1)
  if (
    e.kind === "non-terminal" && e.lft.kind === "inc" && e.rgt.kind === "num"
  ) {
    const result: NativeNum = mkNativeNum(e.rgt.value + 1);
    return { altered: true, expr: result };
  }

  // Handle SKI reduction rules for terminal expressions
  if (e.kind === "non-terminal") {
    // I x -> x
    if (e.lft.kind === "terminal" && e.lft.sym === "I" as SKITerminalSymbol) {
      return { altered: true, expr: e.rgt };
    }

    // K x y -> x
    if (
      e.lft.kind === "non-terminal" &&
      e.lft.lft.kind === "terminal" &&
      e.lft.lft.sym === "K" as SKITerminalSymbol
    ) {
      return { altered: true, expr: e.lft.rgt };
    }

    // S x y z -> (x z) (y z)
    if (
      e.lft.kind === "non-terminal" &&
      e.lft.lft.kind === "non-terminal" &&
      e.lft.lft.lft.kind === "terminal" &&
      e.lft.lft.lft.sym === "S" as SKITerminalSymbol
    ) {
      const x = e.lft.lft.rgt;
      const y = e.lft.rgt;
      const z = e.rgt;
      const result: ConsCell<NativeExpr> = cons(cons(x, z), cons(y, z));
      return { altered: true, expr: result };
    }

    const leftStep = stepNative(e.lft);
    if (leftStep.altered) {
      const result: ConsCell<NativeExpr> = cons(leftStep.expr, e.rgt);
      return { altered: true, expr: result };
    }

    const rightStep = stepNative(e.rgt);
    if (rightStep.altered) {
      const result: ConsCell<NativeExpr> = cons(e.lft, rightStep.expr);
      return { altered: true, expr: result };
    }
  }

  // No reduction possible
  return { altered: false, expr: e };
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

export const unChurchNumber = (church: SKIExpression): number => {
  /* build  (church  INC  (NUM 0)) in the new ADT */
  const natTerm: NativeExpr = reduceNat(
    cons(
      cons(skiToNative(church), mkNativeInc()), // first argument  = INC
      mkNativeNum(0) as NativeExpr, // second argument = 0, type assertion added
    ),
  );

  if (natTerm.kind === "num") return natTerm.value;
  return 0;
};
