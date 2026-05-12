import type { Literal, LocalId, PrimitiveClass, SymbolId } from "./ast.ts";
import type { EffectKind, MiniCoreMetadata, MiniType } from "./metadata.ts";
import type { RuntimeSymbol } from "./runtimeSymbols.ts";

export type BlockLabel = string;

export interface BlockModule {
  symbols: BlockSymbolDef[];
  entry?: SymbolId;
  symbolsByName: ReadonlyMap<string, SymbolId>;
  metadata: MiniCoreMetadata;
}

export type BlockSymbolDef =
  | BlockFunctionDef
  | BlockConstructorDef
  | BlockPrimitiveDef;

export interface BlockFunctionDef {
  kind: "function";
  id: SymbolId;
  name: string;
  /**
   * Function signature params. The entry block params must match this list by
   * id, order, and type.
   */
  params: BlockParam[];
  returnType: MiniType;
  blocks: Block[];
  visibility: BlockVisibility;
}

export interface BlockConstructorDef {
  kind: "constructor";
  id: SymbolId;
  name: string;
  tag: number;
  arity: number;
}

export interface BlockPrimitiveDef {
  kind: "primitive";
  id: SymbolId;
  name: string;
  arity: number;
  strict: boolean[];
  class: PrimitiveClass;
}

export type BlockVisibility = "private" | "exported";

export interface Block {
  label: BlockLabel;
  params: BlockParam[];
  instructions: BlockInstruction[];
  terminator: BlockTerminator;
}

export interface BlockParam {
  /**
   * Defines a local in this block. Values flowing across control-flow edges are
   * passed by terminator args into target block params; captured incoming values
   * should use fresh target param ids rather than reusing the source local id.
   */
  id: LocalId;
  name?: string;
  type: MiniType;
}

export type BlockValueRef = BlockLocalRef | BlockLiteralRef;

export interface BlockLocalRef {
  kind: "local";
  id: LocalId;
  name?: string;
  type: MiniType;
}

export interface BlockLiteralRef {
  kind: "literal";
  value: Literal;
  type: MiniType;
}

export interface BlockInstruction {
  result?: BlockParam;
  resultType: MiniType;
  effects: EffectKind;
  op: BlockInstructionOp;
}

export type BlockInstructionOp =
  | BlockPrimOp
  | BlockCallOp
  | BlockRuntimeCallOp
  | BlockConstructOp
  | BlockMoveOp;

export interface BlockPrimOp {
  kind: "prim";
  target: SymbolId;
  name: string;
  args: BlockValueRef[];
  typeArgs?: MiniType[];
}

export interface BlockCallOp {
  kind: "call";
  target: SymbolId;
  name: string;
  args: BlockValueRef[];
  typeArgs?: MiniType[];
  isTail?: boolean;
}

export interface BlockRuntimeCallOp {
  kind: "runtimeCall";
  name: RuntimeSymbol;
  args: BlockValueRef[];
  isTail?: boolean;
}

export interface BlockConstructOp {
  kind: "construct";
  target: SymbolId;
  name: string;
  args: BlockValueRef[];
  typeArgs?: MiniType[];
}

export interface BlockMoveOp {
  kind: "move";
  value: BlockValueRef;
}

export type BlockTerminator =
  | BlockReturnTerminator
  | BlockJumpTerminator
  | BlockBranchTerminator
  | BlockCaseTerminator
  | BlockUnreachableTerminator;

export interface BlockReturnTerminator {
  kind: "return";
  value?: BlockValueRef;
}

export interface BlockJumpTerminator {
  kind: "jump";
  target: BlockLabel;
  args: BlockValueRef[];
}

export interface BlockBranchTerminator {
  kind: "branch";
  condition: BlockValueRef;
  thenTarget: BlockLabel;
  thenArgs: BlockValueRef[];
  elseTarget: BlockLabel;
  elseArgs: BlockValueRef[];
}

export interface BlockCaseTerminator {
  kind: "case";
  scrutinee: BlockValueRef;
  alts: BlockCaseAlt[];
}

export interface BlockCaseAlt {
  constructor: SymbolId;
  constructorName: string;
  /**
   * Constructor field values introduced by the pattern match. Case target args
   * are these binders followed by `args`; the target block params must match by
   * arity and type, with fresh params for any captured values.
   */
  binders: BlockParam[];
  target: BlockLabel;
  args: BlockValueRef[];
}

export interface BlockUnreachableTerminator {
  kind: "unreachable";
}
