import { describe, it } from "../util/test_shim.ts";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { workspaceRoot } from "../../lib/shared/workspaceRoot.ts";
import { evaluateMiniCore, valueToNat } from "../../lib/minicore/evaluator.ts";
import type {
  ConstructorDef,
  Expr,
  FunctionDef,
  PrimitiveDef,
  Program,
  SymbolDef,
} from "../../lib/minicore/ast.ts";
import {
  MiniCoreValidationError,
  validateMiniCoreProgram,
} from "../../lib/minicore/validator.ts";
import {
  compileMiniCoreModules,
  MiniCoreCompileError,
  type MiniCoreModuleSource,
} from "../../lib/minicore/fromTrip.ts";
import * as miniCoreIndex from "../../lib/minicore/index.ts";

const PRELUDE_URL = join(workspaceRoot, "lib", "prelude.trip");
const NAT_URL = join(workspaceRoot, "lib", "nat.trip");
const BIN_URL = join(workspaceRoot, "lib", "bin.trip");

const fn = (
  id: number,
  name: string,
  arity: number,
  params: number[],
  body: Expr,
): FunctionDef => ({ kind: "function", id, name, arity, params, body });

const ctor = (
  id: number,
  name: string,
  tag: number,
  arity: number,
): ConstructorDef => ({ kind: "constructor", id, name, tag, arity });

const prim = (
  id: number,
  name: string,
  arity: number,
  strict: boolean[] = Array.from({ length: arity }, () => true),
): PrimitiveDef => ({
  kind: "primitive",
  id,
  name,
  arity,
  strict,
  class: "numeric",
});

function program(symbols: SymbolDef[], entry = 0): Program {
  return {
    symbols,
    entry,
    symbolsByName: new Map(symbols.map((symbol) => [symbol.name, symbol.id])),
  };
}

function assertValidationError(program: Program, match: RegExp): void {
  assert.throws(
    () => validateMiniCoreProgram(program),
    (error) =>
      error instanceof MiniCoreValidationError && match.test(error.message),
  );
}

function assertEvalError(program: Program, match: RegExp): void {
  assert.throws(() => evaluateMiniCore(program), match);
}

async function baseModules(): Promise<MiniCoreModuleSource[]> {
  return [
    { name: "Prelude", source: await readFile(PRELUDE_URL, "utf8") },
    { name: "Nat", source: await readFile(NAT_URL, "utf8") },
    { name: "Bin", source: await readFile(BIN_URL, "utf8") },
  ];
}

describe("MiniCore validator", () => {
  it("rejects invalid entries and symbol tables", () => {
    const main = fn(0, "Main.main", 0, [], {
      kind: "lit",
      value: { kind: "nat", value: 0n },
    });

    assertValidationError(program([], 7), /Entry symbol 7 not found/);
    assertValidationError(
      program([prim(0, "Nat.succ", 1)], 0),
      /must be a function/,
    );
    assertValidationError(
      program([fn(0, "Main.main", 1, [0], { kind: "var", id: 0 })]),
      /must have arity 0/,
    );
    assertValidationError(
      program([{ ...main, id: 1 }]),
      /ID mismatch: expected 0, got 1/,
    );
    assertValidationError(
      { symbols: [main], entry: 0, symbolsByName: new Map() },
      /missing from symbolsByName/,
    );
    assertValidationError(
      { symbols: [main], entry: 0, symbolsByName: new Map([["Main.main", 3]]) },
      /symbolsByName mismatch/,
    );
  });

  it("rejects malformed function, primitive, and constructor definitions", () => {
    assertValidationError(
      program([
        fn(0, "Main.main", 0, [], {
          kind: "lit",
          value: { kind: "nat", value: 0n },
        }),
        fn(1, "Main.negative", -1, [], {
          kind: "lit",
          value: { kind: "nat", value: 0n },
        }),
      ]),
      /negative arity/,
    );
    assertValidationError(
      program([fn(0, "Main.main", 0, [0], { kind: "var", id: 0 })]),
      /does not match params length/,
    );
    assertValidationError(
      program([
        fn(0, "Main.main", 0, [], {
          kind: "lit",
          value: { kind: "nat", value: 0n },
        }),
        fn(1, "Main.dup", 2, [0, 0], { kind: "var", id: 0 }),
      ]),
      /duplicate parameters/,
    );
    assertValidationError(
      program([
        fn(0, "Main.main", 0, [], {
          kind: "prim",
          target: 1,
          args: [{ kind: "lit", value: { kind: "nat", value: 0n } }],
        }),
        prim(1, "Nat.succ", 1, []),
      ]),
      /arity\/strictness mismatch/,
    );
    assertValidationError(
      program([
        fn(0, "Main.main", 0, [], {
          kind: "lit",
          value: { kind: "nat", value: 0n },
        }),
        ctor(1, "Main.Bad", 0, -1),
      ]),
      /negative arity/,
    );
  });

  it("rejects malformed expressions", () => {
    assertValidationError(
      program([fn(0, "Main.main", 0, [], { kind: "var", id: 0 })]),
      /unbound/,
    );
    assertValidationError(
      program([
        fn(0, "Main.main", 0, [], { kind: "call", target: 1, args: [] }),
        ctor(1, "Main.C", 0, 0),
      ]),
      /is not a function/,
    );
    assertValidationError(
      program([
        fn(0, "Main.main", 0, [], { kind: "call", target: 1, args: [] }),
        fn(1, "Main.id", 1, [0], { kind: "var", id: 0 }),
      ]),
      /wrong arity/,
    );
    assertValidationError(
      program([
        fn(0, "Main.main", 0, [], { kind: "con", target: 1, fields: [] }),
        prim(1, "Nat.succ", 1),
      ]),
      /is not a constructor/,
    );
    assertValidationError(
      program([
        fn(0, "Main.main", 0, [], { kind: "con", target: 1, fields: [] }),
        ctor(1, "Main.Some", 0, 1),
      ]),
      /wrong arity/,
    );
    assertValidationError(
      program([
        fn(0, "Main.main", 0, [], { kind: "prim", target: 1, args: [] }),
        fn(1, "Main.id", 1, [0], { kind: "var", id: 0 }),
      ]),
      /is not a primitive/,
    );
    assertValidationError(
      program([
        fn(0, "Main.main", 0, [], { kind: "prim", target: 1, args: [] }),
        prim(1, "Nat.succ", 1),
      ]),
      /wrong arity/,
    );
  });

  it("rejects malformed case alternatives", () => {
    assertValidationError(
      program([
        fn(0, "Main.main", 0, [], {
          kind: "case",
          scrutinee: { kind: "con", target: 1, fields: [] },
          alts: [
            {
              constructor: 1,
              binders: [],
              body: { kind: "lit", value: { kind: "nat", value: 1n } },
            },
            {
              constructor: 1,
              binders: [],
              body: { kind: "lit", value: { kind: "nat", value: 2n } },
            },
          ],
        }),
        ctor(1, "Main.C", 0, 0),
      ]),
      /Duplicate constructor/,
    );
    assertValidationError(
      program([
        fn(0, "Main.main", 0, [], {
          kind: "case",
          scrutinee: { kind: "con", target: 1, fields: [] },
          alts: [
            {
              constructor: 2,
              binders: [],
              body: { kind: "lit", value: { kind: "nat", value: 0n } },
            },
          ],
        }),
        ctor(1, "Main.C", 0, 0),
        prim(2, "Nat.succ", 1),
      ]),
      /is not a constructor/,
    );
    assertValidationError(
      program([
        fn(0, "Main.main", 0, [], {
          kind: "case",
          scrutinee: {
            kind: "con",
            target: 1,
            fields: [{ kind: "lit", value: { kind: "nat", value: 0n } }],
          },
          alts: [
            {
              constructor: 1,
              binders: [],
              body: { kind: "lit", value: { kind: "nat", value: 0n } },
            },
          ],
        }),
        ctor(1, "Main.Some", 0, 1),
      ]),
      /wrong binder count/,
    );
    assertValidationError(
      program([
        fn(0, "Main.main", 0, [], {
          kind: "case",
          scrutinee: {
            kind: "con",
            target: 1,
            fields: [
              { kind: "lit", value: { kind: "nat", value: 0n } },
              { kind: "lit", value: { kind: "nat", value: 1n } },
            ],
          },
          alts: [
            { constructor: 1, binders: [0, 0], body: { kind: "var", id: 0 } },
          ],
        }),
        ctor(1, "Main.Pair", 0, 2),
      ]),
      /duplicate binders/,
    );
  });
});

describe("MiniCore evaluator", () => {
  it("evaluates lets, calls, constructors, cases, and telemetry", () => {
    const symbols: SymbolDef[] = [
      fn(0, "Main.main", 0, [], {
        kind: "let",
        bindings: [
          { id: 0, value: { kind: "lit", value: { kind: "nat", value: 4n } } },
        ],
        body: {
          kind: "case",
          scrutinee: {
            kind: "con",
            target: 2,
            fields: [{ kind: "var", id: 0 }],
          },
          alts: [
            {
              constructor: 2,
              binders: [1],
              body: { kind: "call", target: 1, args: [{ kind: "var", id: 1 }] },
            },
          ],
        },
      }),
      fn(1, "Main.succ", 1, [0], {
        kind: "prim",
        target: 3,
        args: [{ kind: "var", id: 0 }],
      }),
      ctor(2, "Main.Box", 0, 1),
      prim(3, "Nat.succ", 1),
    ];

    const result = evaluateMiniCore(program(symbols));

    assert.strictEqual(valueToNat(result.value), 5n);
    assert.deepStrictEqual(result.telemetry, {
      functionEntries: 2,
      caseDispatches: 1,
      constructorAllocs: 1,
      primitiveOps: 1,
      maxRecursionDepth: 2,
    });
  });

  it("executes boolean, nat, bin, and u8 primitives", () => {
    const symbols: SymbolDef[] = [
      fn(0, "Main.main", 0, [], {
        kind: "prim",
        target: 3,
        args: [
          {
            kind: "prim",
            target: 4,
            args: [
              { kind: "lit", value: { kind: "nat", value: 2n } },
              { kind: "lit", value: { kind: "nat", value: 3n } },
            ],
          },
          {
            kind: "prim",
            target: 5,
            args: [
              {
                kind: "con",
                target: 12,
                fields: [
                  {
                    kind: "con",
                    target: 11,
                    fields: [{ kind: "con", target: 10, fields: [] }],
                  },
                ],
              },
            ],
          },
        ],
      }),
      ctor(1, "Prelude.false", 0, 0),
      ctor(2, "Prelude.true", 1, 0),
      prim(3, "Nat.add", 2),
      prim(4, "Nat.mul", 2),
      prim(5, "Nat.fromBin", 1),
      prim(6, "Nat.lte", 2),
      prim(7, "Prelude.not", 1),
      prim(8, "Prelude.addU8", 2),
      prim(9, "Prelude.divU8", 2),
      ctor(10, "Prelude.BZ", 0, 0),
      ctor(11, "Prelude.B0", 1, 1),
      ctor(12, "Prelude.B1", 2, 1),
    ];

    assert.strictEqual(
      valueToNat(evaluateMiniCore(program(symbols)).value),
      7n,
    );

    const ltU8 = program([
      fn(0, "Main.main", 0, [], {
        kind: "prim",
        target: 3,
        args: [
          { kind: "lit", value: { kind: "u8", value: 2 } },
          { kind: "lit", value: { kind: "u8", value: 3 } },
        ],
      }),
      ctor(1, "Prelude.false", 0, 0),
      ctor(2, "Prelude.true", 1, 0),
      prim(3, "Prelude.ltU8", 2),
    ]);
    assert.deepStrictEqual(evaluateMiniCore(ltU8).value, {
      kind: "con",
      tag: 2,
      fields: [],
    });

    const subModEq = program([
      fn(0, "Main.main", 0, [], {
        kind: "prim",
        target: 6,
        args: [
          {
            kind: "prim",
            target: 4,
            args: [
              { kind: "lit", value: { kind: "u8", value: 1 } },
              { kind: "lit", value: { kind: "u8", value: 2 } },
            ],
          },
          {
            kind: "prim",
            target: 5,
            args: [
              { kind: "lit", value: { kind: "u8", value: 9 } },
              { kind: "lit", value: { kind: "u8", value: 0 } },
            ],
          },
        ],
      }),
      ctor(1, "Prelude.false", 0, 0),
      ctor(2, "Prelude.true", 1, 0),
      prim(3, "Prelude.eqU8", 2),
      prim(4, "Prelude.subU8", 2),
      prim(5, "Prelude.modU8", 2),
      prim(6, "Prelude.eqU8", 2),
    ]);
    assert.deepStrictEqual(evaluateMiniCore(subModEq).value, {
      kind: "con",
      tag: 1,
      fields: [],
    });
  });

  it("reports runtime shape errors", () => {
    assertEvalError(
      program([fn(0, "Main.main", 0, [], { kind: "var", id: 0 })]),
      /local 0 is unbound/,
    );
    assertEvalError(
      program([
        fn(0, "Main.main", 0, [], {
          kind: "prim",
          target: 1,
          args: [{ kind: "con", target: 2, fields: [] }],
        }),
        prim(1, "Nat.succ", 1),
        ctor(2, "Main.C", 0, 0),
      ]),
      /Expected nat literal/,
    );
    assertEvalError(
      program([
        fn(0, "Main.main", 0, [], {
          kind: "prim",
          target: 1,
          args: [{ kind: "lit", value: { kind: "nat", value: 0n } }],
        }),
        prim(1, "Prelude.addU8", 2),
      ]),
      /expects 2 argument/,
    );
    assertEvalError(
      program([
        fn(0, "Main.main", 0, [], {
          kind: "prim",
          target: 1,
          args: [{ kind: "lit", value: { kind: "u8", value: 1 } }],
        }),
        prim(1, "Nat.succ", 1),
      ]),
      /Expected nat literal/,
    );
    assertEvalError(
      program([
        fn(0, "Main.main", 0, [], { kind: "prim", target: 1, args: [] }),
        prim(1, "Prelude.error", 0),
      ]),
      /Prelude.error/,
    );
    assertEvalError(
      program([
        fn(0, "Main.main", 0, [], { kind: "prim", target: 1, args: [] }),
        prim(1, "Main.unknown", 0),
      ]),
      /Unknown MiniCore primitive/,
    );
    assertEvalError(
      program([
        fn(0, "Main.main", 0, [], {
          kind: "case",
          scrutinee: { kind: "lit", value: { kind: "nat", value: 0n } },
          alts: [],
        }),
      ]),
      /scrutinee is not a constructor/,
    );
    assertEvalError(
      program([
        fn(0, "Main.main", 0, [], {
          kind: "case",
          scrutinee: { kind: "con", target: 1, fields: [] },
          alts: [
            {
              constructor: 2,
              binders: [],
              body: { kind: "lit", value: { kind: "nat", value: 0n } },
            },
          ],
        }),
        ctor(1, "Main.C", 0, 0),
        ctor(2, "Main.D", 1, 0),
      ]),
      /non-exhaustive case/,
    );
    assertEvalError(
      program([
        fn(0, "Main.main", 0, [], {
          kind: "case",
          scrutinee: {
            kind: "con",
            target: 1,
            fields: [{ kind: "lit", value: { kind: "nat", value: 0n } }],
          },
          alts: [
            {
              constructor: 1,
              binders: [],
              body: { kind: "lit", value: { kind: "nat", value: 0n } },
            },
          ],
        }),
        ctor(1, "Main.C", 0, 1),
      ]),
      /binder count/,
    );
  });
});

describe("MiniCore from Trip lowering", () => {
  it("rejects malformed module sources", async () => {
    const modules = await baseModules();
    assert.throws(
      () =>
        compileMiniCoreModules(
          [
            {
              name: "Wrong",
              source:
                "module Actual\nimport Nat zero\nexport main\npoly main = zero",
            },
          ],
          "Wrong",
        ),
      (error) =>
        error instanceof MiniCoreCompileError &&
        /source name mismatch/.test(error.message),
    );
    assert.throws(
      () =>
        compileMiniCoreModules(
          [{ name: "Empty", source: "poly main = zero" }],
          "Empty",
        ),
      /no module term/,
    );
    assert.throws(
      () =>
        compileMiniCoreModules(
          [
            ...modules,
            {
              name: "Dup",
              source:
                "module Dup\nimport Nat zero\nimport Prelude zero\nexport main\npoly main = zero",
            },
          ],
          "Dup",
        ),
      /Duplicate import zero/,
    );
    assert.throws(
      () => compileMiniCoreModules(modules),
      /No MiniCore entry module found/,
    );
  });

  it("rejects unsupported functions and application shapes", async () => {
    const modules = await baseModules();
    const withMain = (source: string) => [
      ...modules,
      {
        name: "Main",
        source: `module Main\nimport Nat Nat\nimport Nat zero\nimport Nat succ\nimport Prelude Bool\nimport Prelude true\nimport Prelude false\nimport Prelude if\nexport main\n${source}`,
      },
    ];

    assert.throws(
      () => compileMiniCoreModules(withMain("poly main = succ"), "Main"),
      /Nat.succ expects 1 argument\(s\), got 0/,
    );
    assert.throws(
      () => compileMiniCoreModules(withMain("poly main = zero zero"), "Main"),
      /Nat.zero does not accept arguments/,
    );
    assert.throws(
      () => compileMiniCoreModules(withMain("poly main = if true"), "Main"),
      /Prelude.if expects 3 term arguments/,
    );
    assert.doesNotThrow(() =>
      compileMiniCoreModules(withMain("poly main = if true zero zero"), "Main"),
    );
    assert.throws(
      () =>
        compileMiniCoreModules(withMain("poly main = \\x : Nat => x"), "Main"),
      /Entry function Main.main must have arity 0/,
    );
  });

  it("does not treat arbitrary two-argument type applications as Bool eliminators", async () => {
    const modules = [
      ...(await baseModules()),
      {
        name: "Main",
        source: `
          module Main
          import Nat Nat
          import Nat zero
          import Nat succ
          export main
          poly impostor = #A => \\x : A => \\y : A => x
          poly use = \\f : #A -> A -> A -> A =>
            f [Nat] zero (succ zero)
          poly main = use impostor
        `,
      },
    ];

    const program = compileMiniCoreModules(modules, "Main");
    const useSymbol = program.symbols.find((symbol) =>
      symbol.name.startsWith("Main.use$"),
    );

    assert.ok(useSymbol && useSymbol.kind === "function");
    assert.strictEqual(useSymbol.body.kind, "call");
    assert.strictEqual(valueToNat(evaluateMiniCore(program).value), 0n);
  });

  it("lowers matchList, pairs, u8 literals, exported constructors, and if thunks", async () => {
    const modules = [
      ...(await baseModules()),
      {
        name: "Main",
        source: `
          module Main
          import Nat Nat
          import Nat zero
          import Nat succ
          import Prelude Bool
          import Prelude true
          import Prelude if
          import Prelude U8
          import Prelude addU8
          import Prelude List
          import Prelude nil
          import Prelude cons
          import Prelude matchList
          import Prelude Pair
          import Prelude MkPair
          import Prelude fst
          import Prelude snd
          export main
          poly choose = if true (\\u : U8 => succ zero) (\\u : U8 => zero)
          poly headOrZero =
            matchList [Nat] [Nat] (cons [Nat] (succ zero) (nil [Nat])) zero
              (\\h : Nat => \\t : List => h)
          poly main =
            let pair = MkPair [Nat] [Nat] choose headOrZero in
            addU8 #u8(255) #u8(2)
        `,
      },
    ];

    const result = evaluateMiniCore(compileMiniCoreModules(modules, "Main"));

    assert.deepStrictEqual(result.value, {
      kind: "lit",
      value: { kind: "u8", value: 1 },
    });
  });
});

describe("MiniCore index barrel", () => {
  it("exports the public MiniCore runtime API", () => {
    assert.strictEqual(miniCoreIndex.evaluateMiniCore, evaluateMiniCore);
    assert.strictEqual(miniCoreIndex.valueToNat, valueToNat);
    assert.strictEqual(
      miniCoreIndex.compileMiniCoreModules,
      compileMiniCoreModules,
    );
    assert.strictEqual(
      miniCoreIndex.MiniCoreCompileError,
      MiniCoreCompileError,
    );
  });
});
