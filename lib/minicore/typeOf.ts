import type { Expr, LocalId, SymbolId } from "./ast.ts";
import type { AnfAtom, AnfExpr, AnfValue } from "./anfAst.ts";
import {
  miniTypeEquals,
  substituteMiniType,
  typeOfLiteral,
  type MiniCoreMetadata,
  type MiniType,
} from "./metadata.ts";
import { getRuntimeSymbolSignature } from "./runtimeSymbols.ts";

export function typeOfMiniCoreExpr(
  expr: Expr,
  fnId: SymbolId,
  metadata: MiniCoreMetadata,
  localTypes: Map<LocalId, MiniType> = metadata.localTypesByFunction.get(
    fnId,
  ) ?? new Map(),
): MiniType {
  switch (expr.kind) {
    case "var":
      return requireLocalType(localTypes, expr.id);
    case "lit":
      return typeOfLiteral(expr.value);
    case "call": {
      const info = metadata.functions.get(expr.target);
      if (!info) return { kind: "unknown" };
      const typeArgs = expr.typeArgs ?? [];
      if (info.typeScheme?.kind === "forall") {
        if (typeArgs.length !== info.typeScheme.params.length) {
          throw new Error(
            `Function ${expr.target} expects ${info.typeScheme.params.length} type arg(s), got ${typeArgs.length}`,
          );
        }
        const subst = new Map<string, MiniType>();
        info.typeScheme.params.forEach((name, i) => {
          subst.set(name, typeArgs[i]!);
        });
        return substituteMiniType(info.resultType, subst);
      }
      return info.resultType;
    }
    case "prim": {
      const info = metadata.primitives.get(expr.target);
      if (!info) return { kind: "unknown" };
      return info.resultType;
    }
    case "runtimeCall":
      return getRuntimeSymbolSignature(expr.name).result;
    case "con": {
      const info = metadata.constructors.get(expr.target);
      if (!info) return { kind: "unknown" };
      const typeArgs = expr.typeArgs ?? [];
      const dataDef = metadata.dataTypes.get(info.dataType);
      if (dataDef) {
        if (typeArgs.length !== dataDef.typeParams.length) {
          throw new Error(
            `Constructor ${expr.target} expects ${dataDef.typeParams.length} type arg(s), got ${typeArgs.length}`,
          );
        }
        const subst = new Map<string, MiniType>();
        dataDef.typeParams.forEach((name, i) => {
          subst.set(name, typeArgs[i]!);
        });
        return substituteMiniType(info.resultType, subst);
      }
      return info.resultType;
    }
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
    case "call": {
      const info = metadata.functions.get(value.target);
      if (!info) return { kind: "unknown" };
      const typeArgs = value.typeArgs ?? [];
      if (info.typeScheme?.kind === "forall") {
        if (typeArgs.length !== info.typeScheme.params.length) {
          throw new Error(
            `Function ${value.target} expects ${info.typeScheme.params.length} type arg(s), got ${typeArgs.length}`,
          );
        }
        const subst = new Map<string, MiniType>();
        info.typeScheme.params.forEach((name, i) => {
          subst.set(name, typeArgs[i]!);
        });
        return substituteMiniType(info.resultType, subst);
      }
      return info.resultType;
    }
    case "prim": {
      const info = metadata.primitives.get(value.target);
      if (!info) return { kind: "unknown" };
      return info.resultType;
    }
    case "runtimeCall":
      return getRuntimeSymbolSignature(value.name).result;
    case "con": {
      const info = metadata.constructors.get(value.target);
      if (!info) return { kind: "unknown" };
      const typeArgs = value.typeArgs ?? [];
      const dataDef = metadata.dataTypes.get(info.dataType);
      if (dataDef) {
        if (typeArgs.length !== dataDef.typeParams.length) {
          throw new Error(
            `Constructor ${value.target} expects ${dataDef.typeParams.length} type arg(s), got ${typeArgs.length}`,
          );
        }
        const subst = new Map<string, MiniType>();
        dataDef.typeParams.forEach((name, i) => {
          subst.set(name, typeArgs[i]!);
        });
        return substituteMiniType(info.resultType, subst);
      }
      return info.resultType;
    }
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
    case "runtimeCall":
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
