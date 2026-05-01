import {
  emptyMiniCoreMetadata,
  type Block,
  type BlockFunctionDef,
  type BlockModule,
  type BlockParam,
  type BlockPrimitiveDef,
  type BlockSymbolDef,
  type BlockValueRef,
  type MiniCoreMetadata,
  type MiniType,
} from "../../../lib/minicore/index.ts";

export const u8: MiniType = { kind: "u8" };
export const bool: MiniType = { kind: "bool" };
export const unit: MiniType = { kind: "unit" };
export const nat: MiniType = { kind: "nat" };
export const data0: MiniType = { kind: "data", id: 0, args: [] };

export function param(id: number, type: MiniType = u8): BlockParam {
  return { id, type };
}

export function local(id: number, type: MiniType = u8): BlockValueRef {
  return { kind: "local", id, type };
}

export function litU8(value: number): BlockValueRef {
  return { kind: "literal", value: { kind: "u8", value }, type: u8 };
}

export function fn(
  id: number,
  name: string,
  params: BlockParam[],
  returnType: MiniType,
  blocks: Block[],
): BlockFunctionDef {
  return {
    kind: "function",
    id,
    name,
    params,
    returnType,
    blocks,
    visibility: "private",
  };
}

export function prim(id: number, name: string, arity = 2): BlockPrimitiveDef {
  return {
    kind: "primitive",
    id,
    name,
    arity,
    strict: Array.from({ length: arity }, () => true),
    class: "numeric",
  };
}

export function block(
  label: string,
  params: BlockParam[],
  instructions: Block["instructions"],
  terminator: Block["terminator"],
): Block {
  return { label, params, instructions, terminator };
}

export function moduleOf(symbols: BlockSymbolDef[]): BlockModule {
  const metadata = metadataFor(symbols);
  return {
    symbols,
    entry: symbols.find((symbol) => symbol.kind === "function")?.id,
    symbolsByName: new Map(symbols.map((symbol) => [symbol.name, symbol.id])),
    metadata,
  };
}

function metadataFor(symbols: BlockSymbolDef[]): MiniCoreMetadata {
  const metadata = emptyMiniCoreMetadata();
  metadata.dataTypes.set(0, {
    id: 0,
    name: "Main.Box",
    typeParams: [],
    constructors: [99],
  });

  for (const symbol of symbols) {
    switch (symbol.kind) {
      case "function":
        metadata.functions.set(symbol.id, {
          symbol: symbol.id,
          paramTypes: symbol.params.map((fnParam) => fnParam.type),
          resultType: symbol.returnType,
        });
        break;
      case "primitive": {
        const signature = primitiveSignature(symbol.name, symbol.arity);
        metadata.primitives.set(symbol.id, {
          symbol: symbol.id,
          argTypes: signature.args,
          resultType: signature.result,
          strict: symbol.strict,
          effects: "pure",
        });
        break;
      }
      case "constructor":
        metadata.constructors.set(symbol.id, {
          symbol: symbol.id,
          dataType: 0,
          tag: symbol.tag,
          fieldTypes: Array.from({ length: symbol.arity }, () => u8),
          resultType: data0,
        });
        break;
    }
  }
  return metadata;
}

function primitiveSignature(
  name: string,
  arity: number,
): { args: MiniType[]; result: MiniType } {
  switch (name) {
    case "Prelude.eqU8":
    case "Prelude.ltU8":
    case "eqU8":
    case "ltU8":
      return { args: [u8, u8], result: bool };
    case "Prelude.addU8":
    case "Prelude.subU8":
    case "Prelude.divU8":
    case "Prelude.modU8":
    case "addU8":
    case "subU8":
    case "divU8":
    case "modU8":
      return { args: [u8, u8], result: u8 };
    default:
      return {
        args: Array.from({ length: arity }, () => u8),
        result: u8,
      };
  }
}
