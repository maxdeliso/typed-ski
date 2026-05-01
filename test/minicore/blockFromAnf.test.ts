import { describe, it } from "../util/test_shim.ts";
import assert from "node:assert/strict";
import {
  anfToBlockModule,
  emptyMiniCoreMetadata,
  unparseBlockModule,
  type AnfProgram,
  type LocalId,
  type MiniCoreMetadata,
  type MiniType,
} from "../../lib/minicore/index.ts";

const nat: MiniType = { kind: "nat" };
const bool: MiniType = { kind: "bool" };
const maybeNat: MiniType = { kind: "data", id: 0, args: [] };

function maybeNatMetadata(): MiniCoreMetadata {
  const metadata = emptyMiniCoreMetadata();
  metadata.dataTypes.set(0, {
    id: 0,
    name: "Main.MaybeNat",
    typeParams: [],
    constructors: [1, 2],
  });
  metadata.functions.set(0, {
    symbol: 0,
    paramTypes: [nat, maybeNat],
    resultType: nat,
  });
  metadata.constructors.set(1, {
    symbol: 1,
    dataType: 0,
    tag: 0,
    fieldTypes: [],
    resultType: maybeNat,
  });
  metadata.constructors.set(2, {
    symbol: 2,
    dataType: 0,
    tag: 1,
    fieldTypes: [nat],
    resultType: maybeNat,
  });
  metadata.primitives.set(3, {
    symbol: 3,
    argTypes: [nat],
    resultType: nat,
    strict: [true],
    effects: "pure",
  });
  metadata.localTypesByFunction.set(
    0,
    new Map([
      [0, nat],
      [1, maybeNat],
      [2, nat],
      [3, nat],
    ]),
  );
  return metadata;
}

describe("MiniCore Block IR from ANF", () => {
  it("lowers Bool case to branch", () => {
    const metadata = emptyMiniCoreMetadata();
    metadata.dataTypes.set(1, {
      id: 1,
      name: "Prelude.Bool",
      typeParams: [],
      constructors: [1, 2],
    });
    metadata.bool = {
      type: bool,
      dataType: 1,
      falseConstructor: 1,
      trueConstructor: 2,
    };
    metadata.functions.set(0, {
      symbol: 0,
      paramTypes: [bool],
      resultType: nat,
    });
    metadata.constructors.set(1, {
      symbol: 1,
      dataType: 1,
      tag: 0,
      fieldTypes: [],
      resultType: bool,
    });
    metadata.constructors.set(2, {
      symbol: 2,
      dataType: 1,
      tag: 1,
      fieldTypes: [],
      resultType: bool,
    });
    metadata.localTypesByFunction.set(0, new Map([[0, bool]]));

    const program: AnfProgram = {
      entry: 0,
      symbolsByName: new Map([
        ["Main.boolToNat", 0],
        ["Prelude.false", 1],
        ["Prelude.true", 2],
      ]),
      metadata,
      symbols: [
        {
          kind: "function",
          id: 0,
          name: "Main.boolToNat",
          arity: 1,
          params: [0],
          body: {
            kind: "case",
            scrutinee: { kind: "var", id: 0 },
            alts: [
              {
                constructor: 1,
                binders: [],
                body: {
                  kind: "atom",
                  atom: { kind: "lit", value: { kind: "nat", value: 0n } },
                },
              },
              {
                constructor: 2,
                binders: [],
                body: {
                  kind: "atom",
                  atom: { kind: "lit", value: { kind: "nat", value: 1n } },
                },
              },
            ],
          },
        },
        { kind: "constructor", id: 1, name: "Prelude.false", tag: 0, arity: 0 },
        { kind: "constructor", id: 2, name: "Prelude.true", tag: 1, arity: 0 },
      ],
    };

    assert.strictEqual(
      unparseBlockModule(anfToBlockModule(program)),
      [
        "function Main.boolToNat(%0: bool) -> nat [private] {",
        "  entry(%0: bool):",
        "    branch %0 case0_alt1_true() case0_alt0_false()",
        "",
        "  case0_alt0_false:",
        "    return 0",
        "",
        "  case0_alt1_true:",
        "    return 1",
        "}",
      ].join("\n"),
    );
  });

  it("lowers value-position case through an explicit join block", () => {
    const program: AnfProgram = {
      entry: 0,
      symbolsByName: new Map([
        ["Main.getOrSucc", 0],
        ["Main.None", 1],
        ["Main.Some", 2],
        ["Nat.succ", 3],
      ]),
      metadata: maybeNatMetadata(),
      symbols: [
        {
          kind: "function",
          id: 0,
          name: "Main.getOrSucc",
          arity: 2,
          params: [0, 1],
          body: {
            kind: "let",
            id: 3,
            value: {
              kind: "case",
              scrutinee: { kind: "var", id: 1 },
              alts: [
                {
                  constructor: 1,
                  binders: [],
                  body: { kind: "atom", atom: { kind: "var", id: 0 } },
                },
                {
                  constructor: 2,
                  binders: [2],
                  body: { kind: "atom", atom: { kind: "var", id: 2 } },
                },
              ],
            },
            body: {
              kind: "prim",
              target: 3,
              args: [{ kind: "var", id: 3 }],
            },
          },
        },
        { kind: "constructor", id: 1, name: "Main.None", tag: 0, arity: 0 },
        { kind: "constructor", id: 2, name: "Main.Some", tag: 1, arity: 1 },
        {
          kind: "primitive",
          id: 3,
          name: "Nat.succ",
          arity: 1,
          strict: [true],
          class: "numeric",
        },
      ],
    };

    assert.strictEqual(
      unparseBlockModule(anfToBlockModule(program)),
      [
        "function Main.getOrSucc(%0: nat, %1: Main.MaybeNat) -> nat [private] {",
        "  entry(%0: nat, %1: Main.MaybeNat):",
        "    case %1 of",
        "      Main.None -> case0_alt0_None(%0)",
        "      Main.Some(%2: nat) -> case0_alt1_Some(%2)",
        "",
        "  case0_alt0_None(%4: nat):",
        "    jump case0_join(%4)",
        "",
        "  case0_alt1_Some(%2: nat):",
        "    jump case0_join(%2)",
        "",
        "  case0_join(%3: nat):",
        "    %5: nat = prim Nat.succ(%3) : nat !pure",
        "    return %5",
        "}",
      ].join("\n"),
    );
  });

  it("freshens captured values when a case alt also binds fields", () => {
    const metadata = maybeNatMetadata();
    metadata.primitives.set(3, {
      symbol: 3,
      argTypes: [nat, nat],
      resultType: nat,
      strict: [true, true],
      effects: "pure",
    });
    metadata.localTypesByFunction.set(
      0,
      new Map<LocalId, MiniType>([
        [0, nat],
        [1, maybeNat],
        [2, nat],
      ]),
    );

    const program: AnfProgram = {
      entry: 0,
      symbolsByName: new Map([
        ["Main.addDefault", 0],
        ["Main.None", 1],
        ["Main.Some", 2],
        ["Nat.add", 3],
      ]),
      metadata,
      symbols: [
        {
          kind: "function",
          id: 0,
          name: "Main.addDefault",
          arity: 2,
          params: [0, 1],
          body: {
            kind: "case",
            scrutinee: { kind: "var", id: 1 },
            alts: [
              {
                constructor: 1,
                binders: [],
                body: { kind: "atom", atom: { kind: "var", id: 0 } },
              },
              {
                constructor: 2,
                binders: [2],
                body: {
                  kind: "prim",
                  target: 3,
                  args: [
                    { kind: "var", id: 0 },
                    { kind: "var", id: 2 },
                  ],
                },
              },
            ],
          },
        },
        { kind: "constructor", id: 1, name: "Main.None", tag: 0, arity: 0 },
        { kind: "constructor", id: 2, name: "Main.Some", tag: 1, arity: 1 },
        {
          kind: "primitive",
          id: 3,
          name: "Nat.add",
          arity: 2,
          strict: [true, true],
          class: "numeric",
        },
      ],
    };

    assert.strictEqual(
      unparseBlockModule(anfToBlockModule(program)),
      [
        "function Main.addDefault(%0: nat, %1: Main.MaybeNat) -> nat [private] {",
        "  entry(%0: nat, %1: Main.MaybeNat):",
        "    case %1 of",
        "      Main.None -> case0_alt0_None(%0)",
        "      Main.Some(%2: nat) -> case0_alt1_Some(%2, %0)",
        "",
        "  case0_alt0_None(%3: nat):",
        "    return %3",
        "",
        "  case0_alt1_Some(%2: nat, %4: nat):",
        "    %5: nat = prim Nat.add(%4, %2) : nat !pure",
        "    return %5",
        "}",
      ].join("\n"),
    );
  });

  it("derives function visibility from metadata exports", () => {
    const metadata = emptyMiniCoreMetadata();
    metadata.functions.set(0, {
      symbol: 0,
      paramTypes: [],
      resultType: nat,
    });
    metadata.functions.set(1, {
      symbol: 1,
      paramTypes: [],
      resultType: nat,
    });
    metadata.exportedSymbols.add(0);

    const program: AnfProgram = {
      entry: 0,
      symbolsByName: new Map([
        ["Main.worker", 0],
        ["Main.main", 1],
      ]),
      metadata,
      symbols: [
        {
          kind: "function",
          id: 0,
          name: "Main.worker",
          arity: 0,
          params: [],
          body: {
            kind: "atom",
            atom: { kind: "lit", value: { kind: "nat", value: 1n } },
          },
        },
        {
          kind: "function",
          id: 1,
          name: "Main.main",
          arity: 0,
          params: [],
          body: {
            kind: "atom",
            atom: { kind: "lit", value: { kind: "nat", value: 2n } },
          },
        },
      ],
    };

    assert.strictEqual(
      unparseBlockModule(anfToBlockModule(program)),
      [
        "function Main.worker() -> nat [exported] {",
        "  entry:",
        "    return 1",
        "}",
        "",
        "function Main.main() -> nat [private] {",
        "  entry:",
        "    return 2",
        "}",
      ].join("\n"),
    );
  });
});
