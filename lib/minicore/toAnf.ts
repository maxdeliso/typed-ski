import type { Binding, Expr, FunctionDef, LocalId, Program } from "./ast.ts";
import {
  cloneMiniCoreMetadata,
  type MiniCoreMetadata,
  type MiniType,
} from "./metadata.ts";
import { typeOfMiniCoreExpr } from "./typeOf.ts";
import type {
  AnfAtom,
  AnfAtomExpr,
  AnfExpr,
  AnfFunctionDef,
  AnfProgram,
  AnfSymbolDef,
  AnfValue,
} from "./anfAst.ts";

interface AnfState {
  fnSymbol: number;
  nextLocalId: LocalId;
  metadata?: MiniCoreMetadata;
  localTypes: Map<LocalId, MiniType>;
}

type AtomCont = (atom: AnfAtom) => AnfExpr;
type AtomsCont = (atoms: AnfAtom[]) => AnfExpr;
type ValueCont = (value: AnfValue) => AnfExpr;

export function toAnfProgram(program: Program): AnfProgram {
  const metadata = program.metadata
    ? cloneMiniCoreMetadata(program.metadata)
    : undefined;
  const symbols: AnfSymbolDef[] = program.symbols.map((symbol) =>
    symbol.kind === "function"
      ? toAnfFunction(symbol, { ...program, metadata })
      : symbol,
  );
  return {
    symbols,
    entry: program.entry,
    symbolsByName: program.symbolsByName,
    metadata,
  };
}

export function toAnfFunction(
  fn: FunctionDef,
  program?: Program,
): AnfFunctionDef {
  const metadata = program?.metadata;
  const localTypes = new Map(metadata?.localTypesByFunction.get(fn.id) ?? []);
  let maxId = maxLocalIdInFunction(fn);
  for (const id of localTypes.keys()) {
    if (id > maxId) maxId = id;
  }
  const state: AnfState = {
    fnSymbol: fn.id,
    nextLocalId: maxId + 1,
    metadata,
    localTypes,
  };
  const body = normalizeTail(fn.body, state);
  metadata?.localTypesByFunction.set(fn.id, state.localTypes);
  return {
    ...fn,
    body,
  };
}

function atomExpr(atom: AnfAtom): AnfAtomExpr {
  return { kind: "atom", atom };
}

function toAtom(expr: Expr): AnfAtom {
  switch (expr.kind) {
    case "var":
      return { kind: "var", id: expr.id };
    case "lit":
      return { kind: "lit", value: expr.value };
    default:
      throw new Error(`MiniCore ${expr.kind} is not atomic`);
  }
}

function isAtomic(expr: Expr): boolean {
  return expr.kind === "var" || expr.kind === "lit";
}

function normalizeTail(expr: Expr, state: AnfState): AnfExpr {
  switch (expr.kind) {
    case "var":
    case "lit":
      return atomExpr(toAtom(expr));
    case "call":
      return normalizeAtoms(expr.args, state, (args) => ({
        kind: "call",
        target: expr.target,
        args,
        typeArgs: expr.typeArgs,
      }));
    case "con":
      return normalizeAtoms(expr.fields, state, (fields) => ({
        kind: "con",
        target: expr.target,
        fields,
        typeArgs: expr.typeArgs,
      }));
    case "prim":
      return normalizeAtoms(expr.args, state, (args) => ({
        kind: "prim",
        target: expr.target,
        args,
        typeArgs: expr.typeArgs,
      }));
    case "runtimeCall":
      return normalizeAtoms(expr.args, state, (args) => ({
        kind: "runtimeCall",
        name: expr.name,
        args,
      }));
    case "case":
      return normalizeAtom(expr.scrutinee, state, (scrutinee) => ({
        kind: "case",
        scrutinee,
        alts: expr.alts.map((alt) => ({
          constructor: alt.constructor,
          binders: alt.binders,
          body: normalizeTail(alt.body, state),
        })),
      }));
    case "let":
      return normalizeBindings(expr.bindings, state, () =>
        normalizeTail(expr.body, state),
      );
  }
}

function normalizeAtom(expr: Expr, state: AnfState, k: AtomCont): AnfExpr {
  if (isAtomic(expr)) {
    return k(toAtom(expr));
  }

  return normalizeBinding(expr, state, (value) => {
    const tmpId = state.nextLocalId++;
    const tmp: AnfAtom = { kind: "var", id: tmpId };
    recordLocalType(state, tmpId, expr);
    const body = k(tmp);
    return {
      kind: "let",
      id: tmpId,
      value,
      body,
    };
  });
}

function normalizeAtoms(exprs: Expr[], state: AnfState, k: AtomsCont): AnfExpr {
  const atoms: AnfAtom[] = [];

  const loop = (index: number): AnfExpr => {
    if (index >= exprs.length) {
      return k(atoms);
    }
    return normalizeAtom(exprs[index]!, state, (atom) => {
      atoms.push(atom);
      return loop(index + 1);
    });
  };
  return loop(0);
}

function normalizeBinding(expr: Expr, state: AnfState, k: ValueCont): AnfExpr {
  switch (expr.kind) {
    case "var":
    case "lit":
      return k(atomExpr(toAtom(expr)));
    case "call":
      return normalizeAtoms(expr.args, state, (args) =>
        k({ kind: "call", target: expr.target, args, typeArgs: expr.typeArgs }),
      );
    case "con":
      return normalizeAtoms(expr.fields, state, (fields) =>
        k({
          kind: "con",
          target: expr.target,
          fields,
          typeArgs: expr.typeArgs,
        }),
      );
    case "prim":
      return normalizeAtoms(expr.args, state, (args) =>
        k({ kind: "prim", target: expr.target, args, typeArgs: expr.typeArgs }),
      );
    case "runtimeCall":
      return normalizeAtoms(expr.args, state, (args) =>
        k({ kind: "runtimeCall", name: expr.name, args }),
      );
    case "case":
      return normalizeAtom(expr.scrutinee, state, (scrutinee) =>
        k({
          kind: "case",
          scrutinee,
          alts: expr.alts.map((alt) => ({
            constructor: alt.constructor,
            binders: alt.binders,
            body: normalizeTail(alt.body, state),
          })),
        }),
      );
    case "let":
      return normalizeBindings(expr.bindings, state, () =>
        normalizeBinding(expr.body, state, k),
      );
  }
}

function normalizeBindings(
  bindings: Binding[],
  state: AnfState,
  body: () => AnfExpr,
): AnfExpr {
  const loop = (index: number): AnfExpr => {
    if (index >= bindings.length) {
      return body();
    }
    const binding = bindings[index]!;
    return normalizeBinding(binding.value, state, (value) => {
      recordLocalType(state, binding.id, binding.value);
      return {
        kind: "let",
        id: binding.id,
        value,
        body: loop(index + 1),
      };
    });
  };
  return loop(0);
}

function recordLocalType(state: AnfState, id: LocalId, expr: Expr): void {
  if (!state.metadata) {
    return;
  }
  const inferred = typeOfMiniCoreExpr(
    expr,
    state.fnSymbol,
    state.metadata,
    state.localTypes,
  );
  const existing = state.localTypes.get(id);
  if (!existing || existing.kind === "unknown") {
    state.localTypes.set(id, inferred);
  }
}

function maxLocalIdInFunction(fn: FunctionDef): LocalId {
  let max = -1;
  for (const param of fn.params) {
    max = Math.max(max, param);
  }
  visitExprLocals(fn.body, (id) => {
    max = Math.max(max, id);
  });
  return max;
}

function visitExprLocals(expr: Expr, visit: (id: LocalId) => void): void {
  switch (expr.kind) {
    case "var":
      visit(expr.id);
      break;
    case "lit":
      break;
    case "call":
    case "prim":
    case "runtimeCall":
      for (const arg of expr.args) {
        visitExprLocals(arg, visit);
      }
      break;
    case "con":
      for (const field of expr.fields) {
        visitExprLocals(field, visit);
      }
      break;
    case "case":
      visitExprLocals(expr.scrutinee, visit);
      for (const alt of expr.alts) {
        for (const binder of alt.binders) {
          visit(binder);
        }
        visitExprLocals(alt.body, visit);
      }
      break;
    case "let":
      for (const binding of expr.bindings) {
        visit(binding.id);
        visitExprLocals(binding.value, visit);
      }
      visitExprLocals(expr.body, visit);
      break;
  }
}
