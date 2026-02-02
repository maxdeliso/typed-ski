/**
 * Lambda to SKI combinator conversion.
 *
 * This module uses a De Bruijn conversion + arity-tracking abstraction pipeline.
 * It avoids the classic exponential blowup of naive S-expansion by tracking
 * openness (how many arguments a term depends on) and using bulk S/B/C where possible.
 *
 * @module
 */
import type { TripLangValueType } from "../meta/trip.ts";
import type { DeBruijnTerm } from "../meta/frontend/deBruijn.ts";
import type { SKIExpression } from "../ski/expression.ts";
import { apply, applyMany } from "../ski/expression.ts";
import {
  B,
  BPrime,
  C,
  CPrime,
  I,
  K,
  ReadOne,
  S,
  SPrime,
  WriteOne,
} from "../ski/terminal.ts";
import { ConversionError } from "./conversionError.ts";
import { toDeBruijn } from "../meta/frontend/deBruijn.ts";

type CoreTerm =
  | { kind: "idx"; index: number }
  | { kind: "app"; lft: CoreTerm; rgt: CoreTerm }
  | { kind: "lam"; body: CoreTerm }
  | { kind: "terminal"; expr: SKIExpression };

interface Res {
  n: number;
  expr: SKIExpression;
}

const PSI = SPrime;
const BETA = BPrime;
const GAMMA = CPrime;

const terminalFromSym = (sym: string): SKIExpression => {
  switch (sym) {
    case "S":
      return S;
    case "K":
      return K;
    case "I":
      return I;
    case "B":
      return B;
    case "C":
      return C;
    case "P":
      return SPrime;
    case "Q":
      return BPrime;
    case "R":
      return CPrime;
    case ",":
      return ReadOne;
    case ".":
      return WriteOne;
    default:
      throw new ConversionError(`unknown SKI terminal: ${sym}`);
  }
};

const toCore = (term: DeBruijnTerm): CoreTerm => {
  switch (term.kind) {
    case "DbVar":
      return { kind: "idx", index: term.index };
    case "DbAbs":
      return { kind: "lam", body: toCore(term.body) };
    case "DbSysFAbs":
      return { kind: "lam", body: toCore(term.body) };
    case "DbTypedAbs":
      return { kind: "lam", body: toCore(term.body) };
    case "DbApp":
      return {
        kind: "app",
        lft: toCore(term.left),
        rgt: toCore(term.right),
      };
    case "DbLet":
      return {
        kind: "app",
        lft: { kind: "lam", body: toCore(term.body) },
        rgt: toCore(term.value),
      };
    case "DbTerminal":
      return { kind: "terminal", expr: terminalFromSym(term.sym) };
    case "DbFreeVar":
      throw new ConversionError(`free variable detected: ${term.name}`);
    case "DbFreeTypeVar":
      throw new ConversionError(`free type variable detected: ${term.name}`);
    case "DbTyAbs":
    case "DbForall":
    case "DbTyApp":
    case "DbTypeApp":
      throw new ConversionError(
        "type-level constructs present; erase types before SKI conversion",
      );
    case "DbMatch":
      throw new ConversionError(
        "match expressions are not supported in SKI conversion",
      );
  }
};

const selectorCache = new Map<number, SKIExpression>();

const selectOuter = (arity: number): SKIExpression => {
  if (arity <= 0) {
    throw new ConversionError("invalid De Bruijn index (negative arity)");
  }
  const cached = selectorCache.get(arity);
  if (cached) return cached;
  let expr: SKIExpression = I;
  for (let i = 2; i <= arity; i++) {
    expr = applyMany(B, expr, K);
  }
  selectorCache.set(arity, expr);
  return expr;
};

const bulkCache = new Map<string, SKIExpression>();

const emitBulk = (kind: "S" | "B" | "C", depth: number): SKIExpression => {
  if (depth < 1) {
    throw new ConversionError("bulk combinator depth must be >= 1");
  }
  const cacheKey = `${kind}:${depth}`;
  const cached = bulkCache.get(cacheKey);
  if (cached) return cached;
  let expr: SKIExpression = kind === "S" ? S : kind === "B" ? B : C;
  for (let i = 2; i <= depth; i++) {
    expr = apply(
      kind === "S" ? PSI : kind === "B" ? BETA : GAMMA,
      expr,
    );
  }
  bulkCache.set(cacheKey, expr);
  return expr;
};

const liftArity = (
  expr: SKIExpression,
  from: number,
  to: number,
): SKIExpression => {
  if (to < from) {
    throw new ConversionError("cannot lower arity during lift");
  }
  let lifted = expr;
  for (let i = 0; i < to - from; i++) {
    lifted = apply(K, lifted);
  }
  return lifted;
};

const zip = (l: Res, r: Res): Res => {
  const { n, expr: A } = l;
  const { n: m, expr: Bexpr } = r;

  if (n === 0 && m === 0) {
    return { n: 0, expr: apply(A, Bexpr) };
  }

  if (n === 0) {
    return { n: m, expr: applyMany(emitBulk("B", m), A, Bexpr) };
  }

  if (m === 0) {
    return { n, expr: applyMany(emitBulk("C", n), A, Bexpr) };
  }

  if (n === m) {
    return { n, expr: applyMany(emitBulk("S", n), A, Bexpr) };
  }

  if (n < m) {
    const liftedA = liftArity(A, n, m);
    return { n: m, expr: applyMany(emitBulk("S", m), liftedA, Bexpr) };
  }

  const liftedB = liftArity(Bexpr, m, n);
  return { n, expr: applyMany(emitBulk("S", n), A, liftedB) };
};

const compile = (term: CoreTerm): Res => {
  switch (term.kind) {
    case "idx":
      return { n: term.index + 1, expr: selectOuter(term.index + 1) };
    case "app":
      return zip(compile(term.lft), compile(term.rgt));
    case "lam": {
      const body = compile(term.body);
      if (body.n === 0) {
        return { n: 0, expr: apply(K, body.expr) };
      }
      return { n: body.n - 1, expr: body.expr };
    }
    case "terminal":
      return { n: 0, expr: term.expr };
  }
};

/**
 * Converts a TripLang value type into an SKI expression.
 */
export const bracketLambda = (term: TripLangValueType): SKIExpression => {
  const deb = toDeBruijn(term);
  const compiled = compile(toCore(deb));
  if (compiled.n !== 0) {
    throw new ConversionError("free variable detected after conversion");
  }
  return compiled.expr;
};
