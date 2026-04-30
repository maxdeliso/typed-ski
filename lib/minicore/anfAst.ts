import type {
  ConstructorDef,
  FunctionDef,
  Literal,
  LocalId,
  PrimitiveDef,
  Program,
  SymbolId,
} from "./ast.ts";

export type AnfAtom =
  | { kind: "var"; id: LocalId }
  | { kind: "lit"; value: Literal };

export type AnfExpr =
  | AnfAtomExpr
  | AnfLet
  | AnfCall
  | AnfCon
  | AnfPrim
  | AnfCase;

export type AnfValue = AnfAtomExpr | AnfCall | AnfCon | AnfPrim | AnfCase;

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
}

export interface AnfCon {
  kind: "con";
  target: SymbolId;
  fields: AnfAtom[];
}

export interface AnfPrim {
  kind: "prim";
  target: SymbolId;
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
