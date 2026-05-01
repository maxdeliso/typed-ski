import type { MiniCoreMetadata } from "./metadata.ts";
import type { RuntimeSymbol } from "./runtimeSymbols.ts";

export type SymbolId = number;
export type LocalId = number;

export type Literal =
  | { kind: "nat"; value: bigint }
  | { kind: "u8"; value: number };

export interface Program {
  symbols: SymbolDef[];
  entry: SymbolId;
  symbolsByName: ReadonlyMap<string, SymbolId>;
  metadata?: MiniCoreMetadata;
}

export type SymbolDef = FunctionDef | ConstructorDef | PrimitiveDef;

export interface FunctionDef {
  kind: "function";
  id: SymbolId;
  name: string;
  arity: number;
  params: LocalId[];
  body: Expr;
}

export interface ConstructorDef {
  kind: "constructor";
  id: SymbolId;
  name: string;
  tag: number;
  arity: number;
}

export type PrimitiveClass =
  | "numeric"
  | "boolean"
  | "conversion"
  | "library-accelerator";

export interface PrimitiveDef {
  kind: "primitive";
  id: SymbolId;
  name: string;
  arity: number;
  strict: boolean[];
  class: PrimitiveClass;
}

export type Expr =
  | { kind: "var"; id: LocalId }
  | { kind: "lit"; value: Literal }
  | { kind: "call"; target: SymbolId; args: Expr[] }
  | { kind: "con"; target: SymbolId; fields: Expr[] }
  | { kind: "prim"; target: SymbolId; args: Expr[] }
  | { kind: "runtimeCall"; name: RuntimeSymbol; args: Expr[] }
  | { kind: "case"; scrutinee: Expr; alts: Alt[] }
  | { kind: "let"; bindings: Binding[]; body: Expr };

export interface Alt {
  constructor: SymbolId;
  binders: LocalId[];
  body: Expr;
}

export interface Binding {
  id: LocalId;
  value: Expr;
}

export type Value =
  | { kind: "lit"; value: Literal }
  | { kind: "con"; tag: SymbolId; fields: Value[] };
