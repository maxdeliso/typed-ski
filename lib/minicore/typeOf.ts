import type { Expr, LocalId, SymbolId } from "./ast.ts";
import type { AnfAtom, AnfExpr, AnfValue } from "./anfAst.ts";
import {
  miniTypeEquals,
  typeOfLiteral,
  type MiniCoreMetadata,
  type MiniType,
} from "./metadata.ts";

export function typeOfMiniCoreExpr(
  expr: Expr,
  fnId: SymbolId,
  metadata: MiniCoreMetadata,
  localTypes = metadata.localTypesByFunction.get(fnId) ?? new Map(),
): MiniType {
  switch (expr.kind) {
    case "var":
      return requireLocalType(localTypes, expr.id);
    case "lit":
      return typeOfLiteral(expr.value);
    case "call":
      return (
        metadata.functions.get(expr.target)?.resultType ?? {
          kind: "unknown",
        }
      );
    case "prim":
      return (
        metadata.primitives.get(expr.target)?.resultType ?? {
          kind: "unknown",
        }
      );
    case "con":
      return (
        metadata.constructors.get(expr.target)?.resultType ?? {
          kind: "unknown",
        }
      );
    case "case":
      return expr.alts.length === 0
        ? { kind: "unknown" }
        : typeOfMiniCoreExpr(expr.alts[0]!.body, fnId, metadata, localTypes);
    case "let": {
      const nextLocals = new Map(localTypes);
      for (const binding of expr.bindings) {
        const bindingType = typeOfMiniCoreExpr(
          binding.value,
          fnId,
          metadata,
          nextLocals,
        );
        nextLocals.set(binding.id, bindingType);
      }
      return typeOfMiniCoreExpr(expr.body, fnId, metadata, nextLocals);
    }
  }
}

export function typeOfAnfAtom(
  atom: AnfAtom,
  fnId: SymbolId,
  metadata: MiniCoreMetadata,
): MiniType {
  switch (atom.kind) {
    case "lit":
      return typeOfLiteral(atom.value);
    case "var":
      return requireLocalType(
        metadata.localTypesByFunction.get(fnId) ?? new Map(),
        atom.id,
      );
  }
}

export function typeOfAnfValue(
  value: AnfValue,
  fnId: SymbolId,
  metadata: MiniCoreMetadata,
): MiniType {
  switch (value.kind) {
    case "atom":
      return typeOfAnfAtom(value.atom, fnId, metadata);
    case "call":
      return (
        metadata.functions.get(value.target)?.resultType ?? {
          kind: "unknown",
        }
      );
    case "prim":
      return (
        metadata.primitives.get(value.target)?.resultType ?? {
          kind: "unknown",
        }
      );
    case "con":
      return (
        metadata.constructors.get(value.target)?.resultType ?? {
          kind: "unknown",
        }
      );
    case "case":
      return value.alts.length === 0
        ? { kind: "unknown" }
        : typeOfAnfExpr(value.alts[0]!.body, fnId, metadata);
  }
}

export function typeOfAnfExpr(
  expr: AnfExpr,
  fnId: SymbolId,
  metadata: MiniCoreMetadata,
): MiniType {
  switch (expr.kind) {
    case "let":
      return typeOfAnfExpr(expr.body, fnId, metadata);
    case "atom":
    case "call":
    case "con":
    case "prim":
    case "case":
      return typeOfAnfValue(expr, fnId, metadata);
  }
}

export function maybeTypeOfLocal(
  localTypes: Map<LocalId, MiniType>,
  id: LocalId,
): MiniType | undefined {
  return localTypes.get(id);
}

export function sameMiniType(a: MiniType, b: MiniType): boolean {
  return miniTypeEquals(a, b);
}

function requireLocalType(
  localTypes: Map<LocalId, MiniType>,
  id: LocalId,
): MiniType {
  const type = localTypes.get(id);
  if (type === undefined) {
    throw new Error(`No type recorded for local ${id}`);
  }
  return type;
}
