import assert from "node:assert/strict";
import { describe, it } from "../util/test_shim.ts";
import {
  emptyMiniCoreMetadata,
  validateBlockModule,
  type Block,
  type BlockConstructorDef,
  type BlockFunctionDef,
  type BlockModule,
  type BlockParam,
  type BlockSymbolDef,
  type BlockValueRef,
  type MiniCoreMetadata,
  type MiniType,
} from "../../lib/minicore/index.ts";

const u8: MiniType = { kind: "u8" };
const data0: MiniType = { kind: "data", id: 0, args: [] };
const data1: MiniType = { kind: "data", id: 1, args: [] };

function param(id: number, type: MiniType): BlockParam {
  return { id, type };
}

function local(id: number, type: MiniType): BlockValueRef {
  return { kind: "local", id, type };
}

function litU8(value: number): BlockValueRef {
  return { kind: "literal", value: { kind: "u8", value }, type: u8 };
}

function block(
  label: string,
  params: BlockParam[],
  instructions: Block["instructions"],
  terminator: Block["terminator"],
): Block {
  return { label, params, instructions, terminator };
}

function fn(blocks: Block[]): BlockFunctionDef {
  return {
    kind: "function",
    id: 0,
    name: "Main.main",
    params: [param(0, data0)],
    returnType: u8,
    visibility: "private",
    blocks,
  };
}

function moduleOf(
  symbols: BlockSymbolDef[],
  metadata = caseMetadata(),
): BlockModule {
  return {
    symbols,
    entry: 0,
    symbolsByName: new Map(symbols.map((symbol) => [symbol.name, symbol.id])),
    metadata,
  };
}

function caseMetadata(): MiniCoreMetadata {
  const metadata = emptyMiniCoreMetadata();
  metadata.dataTypes.set(0, {
    id: 0,
    name: "Main.MaybeByte",
    typeParams: [],
    constructors: [1, 2],
  });
  metadata.dataTypes.set(1, {
    id: 1,
    name: "Main.Other",
    typeParams: [],
    constructors: [3],
  });
  metadata.functions.set(0, {
    symbol: 0,
    paramTypes: [data0],
    resultType: u8,
  });
  metadata.constructors.set(1, {
    symbol: 1,
    dataType: 0,
    tag: 0,
    fieldTypes: [],
    resultType: data0,
  });
  metadata.constructors.set(2, {
    symbol: 2,
    dataType: 0,
    tag: 1,
    fieldTypes: [u8],
    resultType: data0,
  });
  metadata.constructors.set(3, {
    symbol: 3,
    dataType: 1,
    tag: 0,
    fieldTypes: [],
    resultType: data1,
  });
  return metadata;
}

const constructors: BlockConstructorDef[] = [
  { kind: "constructor", id: 1, name: "Main.None", tag: 0, arity: 0 },
  { kind: "constructor", id: 2, name: "Main.Some", tag: 1, arity: 1 },
  { kind: "constructor", id: 3, name: "Main.Other", tag: 0, arity: 0 },
];

describe("MiniCore Block validation", () => {
  it("accepts case targets whose params begin with the exact binders", () => {
    const module = moduleOf([
      fn([
        block("entry", [param(0, data0)], [], {
          kind: "case",
          scrutinee: local(0, data0),
          alts: [
            {
              constructor: 1,
              constructorName: "Main.None",
              binders: [],
              target: "none",
              args: [litU8(0)],
            },
            {
              constructor: 2,
              constructorName: "Main.Some",
              binders: [param(1, u8)],
              target: "some",
              args: [],
            },
          ],
        }),
        block("none", [param(2, u8)], [], {
          kind: "return",
          value: local(2, u8),
        }),
        block("some", [param(1, u8)], [], {
          kind: "return",
          value: local(1, u8),
        }),
      ]),
      ...constructors,
    ]);

    assert.doesNotThrow(() => validateBlockModule(module));
  });

  it("rejects case target params that do not begin with the exact binders", () => {
    const module = moduleOf([
      fn([
        block("entry", [param(0, data0)], [], {
          kind: "case",
          scrutinee: local(0, data0),
          alts: [
            {
              constructor: 2,
              constructorName: "Main.Some",
              binders: [param(1, u8)],
              target: "some",
              args: [],
            },
          ],
        }),
        block("some", [param(9, u8)], [], {
          kind: "return",
          value: local(9, u8),
        }),
      ]),
      ...constructors,
    ]);

    assert.throws(
      () => validateBlockModule(module),
      /target some param 0 must be binder %1/,
    );
  });

  it("rejects case alternatives from different datatype families", () => {
    const module = moduleOf([
      fn([
        block("entry", [param(0, data0)], [], {
          kind: "case",
          scrutinee: local(0, data0),
          alts: [
            {
              constructor: 1,
              constructorName: "Main.None",
              binders: [],
              target: "none",
              args: [],
            },
            {
              constructor: 3,
              constructorName: "Main.Other",
              binders: [],
              target: "other",
              args: [],
            },
          ],
        }),
        block("none", [], [], { kind: "return", value: litU8(0) }),
        block("other", [], [], { kind: "return", value: litU8(1) }),
      ]),
      ...constructors,
    ]);

    assert.throws(
      () => validateBlockModule(module),
      /belongs to datatype 1, expected 0/,
    );
  });

  it("rejects case scrutinee type mismatches", () => {
    const module = moduleOf([
      {
        ...fn([
          block("entry", [param(0, data1)], [], {
            kind: "case",
            scrutinee: local(0, data1),
            alts: [
              {
                constructor: 1,
                constructorName: "Main.None",
                binders: [],
                target: "none",
                args: [],
              },
            ],
          }),
          block("none", [], [], { kind: "return", value: litU8(0) }),
        ]),
        params: [param(0, data1)],
      },
      ...constructors,
    ]);

    module.metadata.functions.set(0, {
      symbol: 0,
      paramTypes: [data1],
      resultType: u8,
    });

    assert.throws(
      () => validateBlockModule(module),
      /Case scrutinee.*expected compatible with data#0, got data#1/,
    );
  });

  it("rejects duplicate constructor tags within a datatype", () => {
    const metadata = caseMetadata();
    metadata.constructors.set(2, {
      symbol: 2,
      dataType: 0,
      tag: 0,
      fieldTypes: [u8],
      resultType: data0,
    });
    const duplicateTagConstructors: BlockSymbolDef[] = [
      constructors[0]!,
      { ...constructors[1]!, tag: 0 },
      constructors[2]!,
    ];

    const module = moduleOf(
      [
        fn([
          block("entry", [param(0, data0)], [], {
            kind: "return",
            value: litU8(0),
          }),
        ]),
        ...duplicateTagConstructors,
      ],
      metadata,
    );

    assert.throws(
      () => validateBlockModule(module),
      /duplicate constructor tag 0/,
    );
  });
});
