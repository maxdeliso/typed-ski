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
  AddU8,
  B,
  BPrime,
  C,
  CPrime,
  DivU8,
  EqU8,
  I,
  immediate,
  J,
  K,
  LtU8,
  ModU8,
  ReadOne,
  S,
  SKIImmediateFamily,
  SPrime,
  SubU8,
  V,
  WriteOne,
} from "../ski/terminal.ts";
import { ConversionError } from "./conversionError.ts";
import { toDeBruijn } from "../meta/frontend/deBruijn.ts";
import { ChurchN } from "../ski/church.ts";

type CoreTerm =
  | { kind: "idx"; index: number }
  | { kind: "app"; lft: CoreTerm; rgt: CoreTerm }
  | { kind: "lam"; body: CoreTerm }
  | { kind: "terminal"; expr: SKIExpression }
  | { kind: "u8"; value: number };

interface Res {
  n: number;
  expr: SKIExpression;
}

type BlockBinderUse =
  | { kind: "none" }
  | { kind: "one"; index: number }
  | { kind: "many" };

const PSI = SPrime;
const GAMMA = CPrime;

// sbi = S B I
const SBI = applyMany(S, B, I);

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
    case "E":
      return EqU8;
    case "L":
      return LtU8;
    case "D":
      return DivU8;
    case "M":
      return ModU8;
    case "A":
      return AddU8;
    case "O":
      return SubU8;
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
    case "DbImmediate":
      return {
        kind: "terminal",
        expr: immediate(term.family as SKIImmediateFamily, term.value),
      };
    case "DbU8Literal":
      return { kind: "u8", value: term.value };
    case "DbFreeVar":
      if (term.name === "eqU8") return { kind: "terminal", expr: EqU8 };
      if (term.name === "ltU8") return { kind: "terminal", expr: LtU8 };
      if (term.name === "addU8") return { kind: "terminal", expr: AddU8 };
      if (term.name === "subU8") return { kind: "terminal", expr: SubU8 };
      if (term.name === "divU8") return { kind: "terminal", expr: DivU8 };
      if (term.name === "modU8") return { kind: "terminal", expr: ModU8 };
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

const buildAppChain = (head: SKIExpression, args: readonly SKIExpression[]) => {
  let out = head;
  for (const arg of args) {
    out = apply(out, arg);
  }
  return out;
};

const collectLamBlock = (term: CoreTerm): { arity: number; body: CoreTerm } => {
  let arity = 0;
  let body = term;
  while (body.kind === "lam") {
    arity++;
    body = body.body;
  }
  return { arity, body };
};

const collectCoreSpine = (
  term: CoreTerm,
): { head: CoreTerm; args: CoreTerm[] } => {
  const args: CoreTerm[] = [];
  let head = term;
  while (head.kind === "app") {
    args.push(head.rgt);
    head = head.lft;
  }
  args.reverse();
  return { head, args };
};

const combineBlockBinderUse = (
  left: BlockBinderUse,
  right: BlockBinderUse,
): BlockBinderUse => {
  if (left.kind === "many" || right.kind === "many") {
    return { kind: "many" };
  }
  if (left.kind === "none") return right;
  if (right.kind === "none") return left;
  return left.index === right.index ? left : { kind: "many" };
};

const blockBinderUse = (
  term: CoreTerm,
  arity: number,
  depth = 0,
): BlockBinderUse => {
  switch (term.kind) {
    case "idx":
      if (term.index < depth || term.index >= depth + arity) {
        return { kind: "none" };
      }
      return { kind: "one", index: term.index - depth };
    case "app":
      return combineBlockBinderUse(
        blockBinderUse(term.lft, arity, depth),
        blockBinderUse(term.rgt, arity, depth),
      );
    case "lam":
      return blockBinderUse(term.body, arity, depth + 1);
    case "terminal":
    case "u8":
      return { kind: "none" };
  }
};

const isClosedWrtBlock = (
  term: CoreTerm,
  arity: number,
  depth = 0,
): boolean => {
  switch (term.kind) {
    case "idx":
      return term.index < depth || term.index >= depth + arity;
    case "app":
      return (
        isClosedWrtBlock(term.lft, arity, depth) &&
        isClosedWrtBlock(term.rgt, arity, depth)
      );
    case "lam":
      return isClosedWrtBlock(term.body, arity, depth + 1);
    case "terminal":
    case "u8":
      return true;
  }
};

const shiftOutOfBlock = (
  term: CoreTerm,
  arity: number,
  depth = 0,
): CoreTerm => {
  switch (term.kind) {
    case "idx":
      if (term.index < depth) {
        return term;
      }
      if (term.index < depth + arity) {
        throw new ConversionError("term is not closed with respect to block");
      }
      return { kind: "idx", index: term.index - arity };
    case "app":
      return {
        kind: "app",
        lft: shiftOutOfBlock(term.lft, arity, depth),
        rgt: shiftOutOfBlock(term.rgt, arity, depth),
      };
    case "lam":
      return {
        kind: "lam",
        body: shiftOutOfBlock(term.body, arity, depth + 1),
      };
    case "terminal":
    case "u8":
      return term;
  }
};

const shiftOutRemovedBinders = (
  term: CoreTerm,
  retainedArity: number,
  removedArity: number,
  depth = 0,
): CoreTerm => {
  switch (term.kind) {
    case "idx":
      if (term.index < depth + retainedArity) {
        return term;
      }
      return { kind: "idx", index: term.index - removedArity };
    case "app":
      return {
        kind: "app",
        lft: shiftOutRemovedBinders(
          term.lft,
          retainedArity,
          removedArity,
          depth,
        ),
        rgt: shiftOutRemovedBinders(
          term.rgt,
          retainedArity,
          removedArity,
          depth,
        ),
      };
    case "lam":
      return {
        kind: "lam",
        body: shiftOutRemovedBinders(
          term.body,
          retainedArity,
          removedArity,
          depth + 1,
        ),
      };
    case "terminal":
    case "u8":
      return term;
  }
};

const compileClosedRelative = (
  term: CoreTerm,
  arity: number,
): SKIExpression | null => {
  if (!isClosedWrtBlock(term, arity)) return null;
  const shifted = shiftOutOfBlock(term, arity);
  const compiled = compile(shifted);
  return compiled.n === 0 ? compiled.expr : null;
};

const abstractRes = (body: Res): Res => {
  if (body.n === 0) {
    return { n: 0, expr: apply(K, body.expr) };
  }
  return { n: body.n - 1, expr: body.expr };
};

const compileGeneric = (term: CoreTerm): Res => {
  switch (term.kind) {
    case "idx":
      return { n: term.index + 1, expr: selectOuter(term.index + 1) };
    case "app":
      return zip(compileGeneric(term.lft), compileGeneric(term.rgt));
    case "lam":
      return abstractRes(compileGeneric(term.body));
    case "terminal":
      return { n: 0, expr: term.expr };
    case "u8":
      return { n: 0, expr: { kind: "u8", value: term.value } };
  }
};

const selectorDepth = (arity: number, binderIndex: number): number =>
  arity - 1 - binderIndex;

const tryCompileSelectorCanonical = (
  arity: number,
  body: CoreTerm,
): SKIExpression | null => {
  // Exact J/V payloads only preserve semantics when the selected binder is the
  // innermost binder of the block; otherwise J's extra-arg reapplication would
  // feed the skipped inner binders back into the selected head.
  if (body.kind === "idx" && body.index === 0) {
    return selectorExpr(selectorDepth(arity, body.index), V(0));
  }

  if (body.kind === "app" && body.rgt.kind === "idx" && body.rgt.index === 0) {
    const head = compileClosedRelative(body.lft, arity);
    if (head !== null) {
      return selectorExpr(selectorDepth(arity, body.rgt.index), head);
    }
  }

  const { head, args } = collectCoreSpine(body);
  if (head.kind === "idx" && head.index === 0) {
    const staged = args
      .map((arg) => compileClosedRelative(arg, arity))
      .filter((arg): arg is SKIExpression => arg !== null);
    if (staged.length === args.length) {
      return selectorExpr(
        selectorDepth(arity, head.index),
        buildAppChain(V(staged.length), staged),
      );
    }
  }

  return null;
};

const tryCompileLambdaBlock = (
  arity: number,
  body: CoreTerm,
): SKIExpression | null => {
  if (arity <= 0) return null;

  const canonical = tryCompileSelectorCanonical(arity, body);
  if (canonical !== null) {
    return canonical;
  }

  const binderUse = blockBinderUse(body, arity);
  if (binderUse.kind !== "one") {
    return null;
  }

  const retainedArity = binderUse.index + 1;
  const removedArity = arity - retainedArity;
  const shiftedBody = shiftOutRemovedBinders(body, retainedArity, removedArity);
  const payload = compileGeneric(shiftedBody);

  if (payload.n !== retainedArity) {
    return null;
  }

  return selectorExpr(removedArity, payload.expr);
};

const selectorExpr = (depth: number, payload: SKIExpression): SKIExpression =>
  apply(J(depth), payload);

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

const getBitsLog = (n: number): number[] => {
  const bits: number[] = [];
  let q = n;
  while (q > 0) {
    bits.push(q % 2);
    q = Math.floor(q / 2);
  }
  return bits;
};

const emitBulk = (kind: "S" | "B" | "C", depth: number): SKIExpression => {
  if (depth < 1) {
    throw new ConversionError("bulk combinator depth must be >= 1");
  }
  if (depth === 1) {
    return terminalFromSym(kind);
  }
  const cacheKey = `${kind}:${depth}`;
  const cached = bulkCache.get(cacheKey);
  if (cached) return cached;

  // bits n = [LSB, ..., MSB]. Drop the MSB.
  const bits = getBitsLog(depth).slice(0, -1);

  if (kind === "B") {
    const bbSbi = applyMany(B, apply(B, B), SBI);
    const branches = [SBI, bbSbi] as const;

    let expr: SKIExpression = B;
    for (let i = bits.length - 1; i >= 0; i--) {
      const bit = bits[i]!;
      expr = apply(branches[bit]!, expr);
    }

    bulkCache.set(cacheKey, expr);
    return expr;
  }

  // Use native Turner primes for S/C.
  const prime = kind === "S" ? PSI : GAMMA;
  const bbPrimeSbi = applyMany(B, apply(B, prime), SBI);
  const branches = [SBI, bbPrimeSbi] as const;

  let expr: SKIExpression = prime;
  for (let i = bits.length - 1; i >= 0; i--) {
    const bit = bits[i]!;
    expr = apply(branches[bit]!, expr);
  }

  // S/C bulk emitters require the final application to I.
  expr = apply(expr, I);
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
  if (to === from) {
    return expr;
  }

  const dropsNeeded = to - from;
  // ChurchN(d) K expr extentionally equals K applied d times to expr.
  return applyMany(ChurchN(dropsNeeded), K, expr);
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
      const block = collectLamBlock(term);
      const special = tryCompileLambdaBlock(block.arity, block.body);
      if (special !== null) {
        return { n: 0, expr: special };
      }
      return abstractRes(compile(term.body));
    }
    case "terminal":
      return { n: 0, expr: term.expr };
    case "u8":
      return { n: 0, expr: { kind: "u8", value: term.value } };
  }
};

/**
 * Converts a TripLang value type into an SKI expression.
 */
export const bracketLambda = (term: TripLangValueType): SKIExpression => {
  const deb = toDeBruijn(term);
  const core = toCore(deb);
  const compiled = compile(core);
  if (compiled.n !== 0) {
    throw new ConversionError("free variable detected after conversion");
  }
  return compiled.expr;
};
