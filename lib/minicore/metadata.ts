import type { BaseType, Polarity } from "../types/types.ts";
import type { Literal, LocalId, SymbolId } from "./ast.ts";

export type TypeId = number;

export type EffectKind = "pure" | "io" | "alloc" | "trap" | "unknown";

export type MiniType =
  | { kind: "nat" }
  | { kind: "u8" }
  | { kind: "bool" }
  | { kind: "unit" }
  | { kind: "data"; id: TypeId; args: MiniType[] }
  | { kind: "fn"; params: MiniType[]; result: MiniType }
  | { kind: "forall"; params: string[]; body: MiniType }
  | { kind: "var"; name: string }
  | { kind: "unknown" };

export interface DataTypeDef {
  id: TypeId;
  name: string;
  typeParams: string[];
  constructors: SymbolId[];
}

export interface ConstructorInfo {
  symbol: SymbolId;
  dataType: TypeId;
  tag: number;
  fieldTypes: MiniType[];
  resultType: MiniType;
}

export type LoweringHint = BoolEliminatorLoweringHint;

export interface BoolEliminatorLoweringHint {
  kind: "boolEliminator";
  mode: "conditionAsCallee" | "functionStyle";
  conditionArg?: number;
  thenArg: number;
  elseArg: number;
}

export interface FunctionInfo {
  symbol: SymbolId;
  paramTypes: MiniType[];
  resultType: MiniType;
  typeScheme?: MiniType;
  loweringHint?: LoweringHint;
}

export interface PrimitiveInfo {
  symbol: SymbolId;
  argTypes: MiniType[];
  resultType: MiniType;
  strict: boolean[];
  effects: EffectKind;
}

export interface MiniCoreMetadata {
  dataTypes: Map<TypeId, DataTypeDef>;
  constructors: Map<SymbolId, ConstructorInfo>;
  functions: Map<SymbolId, FunctionInfo>;
  primitives: Map<SymbolId, PrimitiveInfo>;
  localTypesByFunction: Map<SymbolId, Map<LocalId, MiniType>>;
  /** Symbols exported by source modules; Block IR uses this for visibility. */
  exportedSymbols: Set<SymbolId>;
  bool?: {
    type: MiniType;
    dataType: TypeId;
    trueConstructor: SymbolId;
    falseConstructor: SymbolId;
  };
}

export function emptyMiniCoreMetadata(): MiniCoreMetadata {
  return {
    dataTypes: new Map(),
    constructors: new Map(),
    functions: new Map(),
    primitives: new Map(),
    localTypesByFunction: new Map(),
    exportedSymbols: new Set(),
  };
}

export function cloneMiniCoreMetadata(
  metadata: MiniCoreMetadata,
): MiniCoreMetadata {
  return {
    dataTypes: new Map(metadata.dataTypes),
    constructors: new Map(metadata.constructors),
    functions: new Map(metadata.functions),
    primitives: new Map(metadata.primitives),
    localTypesByFunction: new Map(
      [...metadata.localTypesByFunction].map(([fn, locals]) => [
        fn,
        new Map(locals),
      ]),
    ),
    exportedSymbols: new Set(metadata.exportedSymbols),
    bool: metadata.bool,
  };
}

export function getMiniTypePolarity(type: MiniType): Polarity {
  switch (type.kind) {
    case "nat":
    case "u8":
    case "bool":
    case "unit":
    case "data":
    case "var":
    case "unknown":
      return "positive";
    case "fn":
    case "forall":
      return "negative";
  }
}

export function typeOfLiteral(literal: Literal): MiniType {
  return literal.kind === "u8" ? { kind: "u8" } : { kind: "nat" };
}

export function miniTypeFromBaseType(
  type: BaseType,
  resolveDataType?: (name: string) => MiniType | TypeId | undefined,
): MiniType {
  switch (type.kind) {
    case "thunk":
      return { kind: "unknown" };
    case "type-var": {
      switch (type.typeName) {
        case "Nat":
          return { kind: "nat" };
        case "U8":
          return { kind: "u8" };
        case "Bool":
          return { kind: "bool" };
        case "Unit":
          return { kind: "unit" };
        default: {
          const resolved = resolveDataType?.(type.typeName);
          if (resolved === undefined) {
            return { kind: "var", name: type.typeName };
          }
          if (typeof resolved === "object") {
            return resolved;
          }
          return { kind: "data", id: resolved, args: [] };
        }
      }
    }
    case "forall": {
      const params: string[] = [];
      let current: BaseType = type;
      while (current.kind === "forall") {
        params.push(current.typeVar);
        current = current.body;
      }
      return {
        kind: "forall",
        params,
        body: miniTypeFromBaseType(current, resolveDataType),
      };
    }
    case "type-app": {
      const args: MiniType[] = [];
      let head: BaseType = type;
      while (head.kind === "type-app") {
        args.unshift(miniTypeFromBaseType(head.arg, resolveDataType));
        head = head.fn;
      }
      if (head.kind === "type-var") {
        const resolved = resolveDataType?.(head.typeName);
        if (resolved !== undefined) {
          if (typeof resolved === "object") {
            if (resolved.kind === "data") {
              return { ...resolved, args };
            }
            return resolved;
          }
          return { kind: "data", id: resolved, args };
        }
        if (head.typeName === "List") {
          const listType = resolveDataType?.("Prelude.List");
          if (listType !== undefined) {
            if (typeof listType === "object") {
              if (listType.kind === "data") {
                return { ...listType, args };
              }
              return listType;
            }
            return { kind: "data", id: listType, args };
          }
        }
      }
      return { kind: "unknown" };
    }
    case "non-terminal": {
      const params: MiniType[] = [];
      let current: BaseType = type;
      while (current.kind === "non-terminal") {
        params.push(miniTypeFromBaseType(current.lft, resolveDataType));
        current = current.rgt;
      }
      return {
        kind: "fn",
        params,
        result: miniTypeFromBaseType(current, resolveDataType),
      };
    }
  }
}

export function miniTypeEquals(a: MiniType, b: MiniType): boolean {
  if (a.kind === "unknown" || b.kind === "unknown") return true;

  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case "nat":
    case "u8":
    case "bool":
    case "unit":
      return true;
    case "var":
      return a.name === (b as Extract<MiniType, { kind: "var" }>).name;
    case "data": {
      const bData = b as Extract<MiniType, { kind: "data" }>;
      return (
        a.id === bData.id &&
        a.args.length === bData.args.length &&
        a.args.every((arg, index) => miniTypeEquals(arg, bData.args[index]!))
      );
    }
    case "fn": {
      const bFn = b as Extract<MiniType, { kind: "fn" }>;
      return (
        a.params.length === bFn.params.length &&
        a.params.every((param, index) =>
          miniTypeEquals(param, bFn.params[index]!),
        ) &&
        miniTypeEquals(a.result, bFn.result)
      );
    }
    case "forall": {
      const bForall = b as Extract<MiniType, { kind: "forall" }>;
      return (
        a.params.length === bForall.params.length &&
        a.params.every((p, i) => p === bForall.params[i]) &&
        miniTypeEquals(a.body, bForall.body)
      );
    }
  }
}

/**
 * Unifies two MiniTypes, updating the provided substitution map.
 * @throws Error if the types cannot be unified.
 */
export function miniTypeUnify(
  a: MiniType,
  b: MiniType,
  subst: Map<string, MiniType>,
): void {
  if (a.kind === "unknown" || b.kind === "unknown") return;

  if (a.kind === "var") {
    const existing = subst.get(a.name);
    if (existing) {
      return miniTypeUnify(existing, b, subst);
    }
    if (b.kind === "var" && a.name === b.name) return;
    subst.set(a.name, b);
    return;
  }

  if (b.kind === "var") {
    const existing = subst.get(b.name);
    if (existing) {
      return miniTypeUnify(a, existing, subst);
    }
    subst.set(b.name, a);
    return;
  }

  if (a.kind !== b.kind) {
    throw new Error(`Cannot unify ${a.kind} with ${b.kind}`);
  }

  switch (a.kind) {
    case "nat":
    case "u8":
    case "bool":
    case "unit":
      return;
    case "data": {
      const bData = b as Extract<MiniType, { kind: "data" }>;
      if (a.id !== bData.id) {
        throw new Error(`Data type ID mismatch: ${a.id} vs ${bData.id}`);
      }
      if (a.args.length !== bData.args.length) {
        throw new Error(
          `Data type arity mismatch: ${a.args.length} vs ${bData.args.length}`,
        );
      }
      a.args.forEach((arg, i) => miniTypeUnify(arg, bData.args[i]!, subst));
      return;
    }
    case "fn": {
      const bFn = b as Extract<MiniType, { kind: "fn" }>;
      if (a.params.length !== bFn.params.length) {
        throw new Error(
          `Function arity mismatch: ${a.params.length} vs ${bFn.params.length}`,
        );
      }
      a.params.forEach((param, i) =>
        miniTypeUnify(param, bFn.params[i]!, subst),
      );
      miniTypeUnify(a.result, bFn.result, subst);
      return;
    }
    case "forall": {
      const bForall = b as Extract<MiniType, { kind: "forall" }>;
      if (a.params.length !== bForall.params.length) {
        throw new Error(`Forall params mismatch`);
      }
      miniTypeUnify(a.body, bForall.body, subst);
      return;
    }
  }
}

export function miniTypeToString(type: MiniType): string {
  switch (type.kind) {
    case "nat":
    case "u8":
    case "bool":
    case "unit":
    case "unknown":
      return type.kind;
    case "var":
      return type.name;
    case "data":
      return `data#${type.id}${
        type.args.length === 0
          ? ""
          : `<${type.args.map(miniTypeToString).join(", ")}>`
      }`;
    case "fn":
      return `(${[...type.params, type.result]
        .map(miniTypeToString)
        .join(" -> ")})`;
    case "forall":
      return `forall ${type.params.join(" ")}. ${miniTypeToString(type.body)}`;
  }
}

export function assertMiniTypeEquals(
  actual: MiniType,
  expected: MiniType,
  message: string,
): void {
  if (!miniTypeEquals(actual, expected)) {
    throw new Error(
      `${message}: expected ${miniTypeToString(expected)}, got ${miniTypeToString(
        actual,
      )}`,
    );
  }
}

export function substituteMiniType(
  type: MiniType,
  subst: ReadonlyMap<string, MiniType>,
): MiniType {
  switch (type.kind) {
    case "var":
      return subst.get(type.name) ?? type;
    case "data":
      return {
        ...type,
        args: type.args.map((arg) => substituteMiniType(arg, subst)),
      };
    case "fn":
      return {
        ...type,
        params: type.params.map((param) => substituteMiniType(param, subst)),
        result: substituteMiniType(type.result, subst),
      };
    case "forall":
      // Note: simplistic, doesn't handle shadow-safe substitution but
      // sufficient for MiniCore which uses it for ADT specialization.
      return {
        ...type,
        body: substituteMiniType(type.body, subst),
      };
    default:
      return type;
  }
}
