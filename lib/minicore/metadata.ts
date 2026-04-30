import type { BaseType } from "../types/types.ts";
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
    bool: metadata.bool,
  };
}

export function typeOfLiteral(literal: Literal): MiniType {
  return literal.kind === "u8" ? { kind: "u8" } : { kind: "nat" };
}

export function miniTypeFromBaseType(
  type: BaseType,
  resolveDataType?: (name: string) => TypeId | undefined,
): MiniType {
  switch (type.kind) {
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
          const dataType = resolveDataType?.(type.typeName);
          return dataType === undefined
            ? { kind: "var", name: type.typeName }
            : { kind: "data", id: dataType, args: [] };
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
        const dataType = resolveDataType?.(head.typeName);
        if (dataType !== undefined) {
          return { kind: "data", id: dataType, args };
        }
        if (head.typeName === "List") {
          const listType = resolveDataType?.("Prelude.List");
          if (listType !== undefined) {
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
      return b.kind === "var" && a.name === b.name;
    case "data":
      return (
        b.kind === "data" &&
        a.id === b.id &&
        a.args.length === b.args.length &&
        a.args.every((arg, index) => miniTypeEquals(arg, b.args[index]!))
      );
    case "fn":
      return (
        b.kind === "fn" &&
        a.params.length === b.params.length &&
        a.params.every((param, index) =>
          miniTypeEquals(param, b.params[index]!),
        ) &&
        miniTypeEquals(a.result, b.result)
      );
    case "forall":
      return b.kind === "forall" && miniTypeEquals(a.body, b.body);
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
