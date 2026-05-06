import type {
  ConstructorDef,
  FunctionDef,
  Literal,
  LocalId,
  PrimitiveDef,
  Program,
  SymbolId,
} from "./ast.ts";
import type { MiniType } from "./metadata.ts";
import type { RuntimeSymbol } from "./runtimeSymbols.ts";

export type AnfAtom =
  | { kind: "var"; id: LocalId }
  | { kind: "lit"; value: Literal };

export type AnfExpr =
  | AnfAtomExpr
  | AnfLet
  | AnfCall
  | AnfCon
  | AnfPrim
  | AnfRuntimeCall
  | AnfCase;

export type AnfValue =
  | AnfAtomExpr
  | AnfCall
  | AnfCon
  | AnfPrim
  | AnfRuntimeCall
  | AnfCase;

export interface AnfAtomExpr {
  kind: "atom";
  atom: AnfAtom;
}

export interface AnfLet {
  kind: "let";
  id: LocalId;
  value: AnfValue;
  body: AnfExpr;
}

export interface AnfCall {
  kind: "call";
  target: SymbolId;
  args: AnfAtom[];
  typeArgs?: MiniType[];
}

export interface AnfCon {
  kind: "con";
  target: SymbolId;
  fields: AnfAtom[];
  typeArgs?: MiniType[];
}

export interface AnfPrim {
  kind: "prim";
  target: SymbolId;
  args: AnfAtom[];
  typeArgs?: MiniType[];
}

export interface AnfRuntimeCall {
  kind: "runtimeCall";
  name: RuntimeSymbol;
  args: AnfAtom[];
}

export interface AnfCase {
  kind: "case";
  scrutinee: AnfAtom;
  alts: AnfAlt[];
}

export interface AnfAlt {
  constructor: SymbolId;
  binders: LocalId[];
  body: AnfExpr;
}

export interface AnfFunctionDef extends Omit<FunctionDef, "body"> {
  body: AnfExpr;
}

export type AnfSymbolDef = AnfFunctionDef | ConstructorDef | PrimitiveDef;

export interface AnfProgram extends Omit<Program, "symbols"> {
  symbols: AnfSymbolDef[];
}
