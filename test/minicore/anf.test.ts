import { describe, it } from "../util/test_shim.ts";
import assert from "node:assert/strict";
import {
  anfToMiniCoreProgram,
  evaluateMiniCore,
  MiniCoreAnfValidationError,
  toAnfProgram,
  unparseAnfProgram,
  unparseAnfExpr,
  validateAnfExecutable,
  validateAnfModule,
  validateAnfProgram,
  valueToNat,
  type AnfExpr,
  type AnfProgram,
} from "../../lib/minicore/index.ts";
import type {
  ConstructorDef,
  Expr,
  FunctionDef,
  PrimitiveDef,
  Program,
  SymbolDef,
} from "../../lib/minicore/ast.ts";

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

const prim = (id: number, name: string, arity: number): PrimitiveDef => ({
  kind: "primitive",
  id,
  name,
  arity,
  strict: Array.from({ length: arity }, () => true),
  class: "numeric",
});

function program(symbols: SymbolDef[], entry = 0): Program {
  return {
    symbols,
    entry,
    symbolsByName: new Map(symbols.map((symbol) => [symbol.name, symbol.id])),
  };
}

function assertAnfValidationError(input: AnfProgram, match: RegExp): void {
  assert.throws(
    () => validateAnfProgram(input),
    (error) =>
      error instanceof MiniCoreAnfValidationError && match.test(error.message),
  );
}

describe("MiniCore ANF", () => {
  it("preserves tail primitive expressions without an administrative let", () => {
    const source = program([
      fn(0, "Main.main", 0, [], {
        kind: "prim",
        target: 1,
        args: [
          { kind: "lit", value: { kind: "nat", value: 1n } },
          { kind: "lit", value: { kind: "nat", value: 2n } },
        ],
      }),
      prim(1, "Nat.add", 2),
    ]);

    const anf = toAnfProgram(source);

    validateAnfProgram(anf);
    assert.strictEqual(unparseAnfProgram(anf), "Main.main =\n  Nat.add 1 2");
  });

  it("normalizes nested primitive operands left-to-right", () => {
    const source = program([
      fn(0, "Main.main", 0, [], {
        kind: "prim",
        target: 1,
        args: [
          {
            kind: "prim",
            target: 2,
            args: [
              { kind: "lit", value: { kind: "nat", value: 2n } },
              { kind: "lit", value: { kind: "nat", value: 3n } },
            ],
          },
          {
            kind: "prim",
            target: 3,
            args: [{ kind: "lit", value: { kind: "nat", value: 4n } }],
          },
        ],
      }),
      prim(1, "Nat.add", 2),
      prim(2, "Nat.mul", 2),
      prim(3, "Nat.succ", 1),
    ]);

    const anf = toAnfProgram(source);

    validateAnfProgram(anf);
    assert.strictEqual(
      unparseAnfProgram(anf),
      [
        "Main.main =",
        "  let %0 = Nat.mul 2 3",
        "  in",
        "  let %1 = Nat.succ 4",
        "  in",
        "  Nat.add %0 %1",
      ].join("\n"),
    );
  });

  it("normalizes complex case scrutinees before dispatch", () => {
    const source = program([
      fn(0, "Main.main", 0, [], {
        kind: "case",
        scrutinee: {
          kind: "con",
          target: 1,
          fields: [
            {
              kind: "prim",
              target: 2,
              args: [{ kind: "lit", value: { kind: "nat", value: 1n } }],
            },
          ],
        },
        alts: [
          {
            constructor: 1,
            binders: [7],
            body: { kind: "var", id: 7 },
          },
        ],
      }),
      ctor(1, "Main.Box", 0, 1),
      prim(2, "Nat.succ", 1),
    ]);

    const anf = toAnfProgram(source);

    validateAnfProgram(anf);
    assert.strictEqual(
      unparseAnfProgram(anf),
      [
        "Main.main =",
        "  let %8 = Nat.succ 1",
        "  in",
        "  let %9 = Main.Box %8",
        "  in",
        "  case %9 of",
        "    Main.Box %7 ->",
        "      %7",
      ].join("\n"),
    );
  });

  it("floats prerequisite lets before source let bindings", () => {
    const source = program([
      fn(0, "Main.main", 0, [], {
        kind: "let",
        bindings: [
          {
            id: 0,
            value: {
              kind: "call",
              target: 1,
              args: [
                {
                  kind: "prim",
                  target: 3,
                  args: [{ kind: "lit", value: { kind: "nat", value: 1n } }],
                },
              ],
            },
          },
        ],
        body: { kind: "call", target: 2, args: [{ kind: "var", id: 0 }] },
      }),
      fn(1, "Main.f", 1, [0], { kind: "var", id: 0 }),
      fn(2, "Main.g", 1, [0], { kind: "var", id: 0 }),
      prim(3, "Nat.succ", 1),
    ]);

    const anf = toAnfProgram(source);

    validateAnfProgram(anf);
    assert.strictEqual(
      unparseAnfProgram(anf).split("\n\n")[0],
      [
        "Main.main =",
        "  let %1 = Nat.succ 1",
        "  in",
        "  let %0 = Main.f %1",
        "  in",
        "  Main.g %0",
      ].join("\n"),
    );
  });

  it("binds a non-tail case operand before its consuming primitive", () => {
    const source = program([
      fn(0, "Main.main", 0, [], {
        kind: "prim",
        target: 2,
        args: [
          {
            kind: "case",
            scrutinee: { kind: "con", target: 1, fields: [] },
            alts: [
              {
                constructor: 1,
                binders: [],
                body: { kind: "lit", value: { kind: "nat", value: 4n } },
              },
            ],
          },
          { kind: "lit", value: { kind: "nat", value: 1n } },
        ],
      }),
      ctor(1, "Main.C", 0, 0),
      prim(2, "Nat.add", 2),
    ]);

    const anf = toAnfProgram(source);

    validateAnfProgram(anf);
    assert.strictEqual(
      unparseAnfProgram(anf),
      [
        "Main.main =",
        "  let %0 = Main.C",
        "  in",
        "  let %1 = case %0 of",
        "    Main.C ->",
        "      4",
        "  in",
        "  Nat.add %1 1",
      ].join("\n"),
    );
  });

  it("normalizes nested lets inside case branch bodies", () => {
    const source = program([
      fn(0, "Main.main", 0, [], {
        kind: "case",
        scrutinee: {
          kind: "con",
          target: 3,
          fields: [{ kind: "lit", value: { kind: "nat", value: 1n } }],
        },
        alts: [
          {
            constructor: 3,
            binders: [0],
            body: {
              kind: "let",
              bindings: [
                {
                  id: 1,
                  value: {
                    kind: "call",
                    target: 1,
                    args: [{ kind: "var", id: 0 }],
                  },
                },
              ],
              body: { kind: "call", target: 2, args: [{ kind: "var", id: 1 }] },
            },
          },
        ],
      }),
      fn(1, "Main.f", 1, [0], { kind: "var", id: 0 }),
      fn(2, "Main.g", 1, [0], { kind: "var", id: 0 }),
      ctor(3, "Main.Box", 0, 1),
    ]);

    const anf = toAnfProgram(source);

    validateAnfProgram(anf);
    assert.strictEqual(
      unparseAnfProgram(anf).split("\n\n")[0],
      [
        "Main.main =",
        "  let %2 = Main.Box 1",
        "  in",
        "  case %2 of",
        "    Main.Box %0 ->",
        "      let %1 = Main.f %0",
        "      in",
        "      Main.g %1",
      ].join("\n"),
    );
  });

  it("round-trips through MiniCore evaluation", () => {
    const source = program([
      fn(0, "Main.main", 0, [], {
        kind: "prim",
        target: 1,
        args: [
          {
            kind: "prim",
            target: 2,
            args: [
              { kind: "lit", value: { kind: "nat", value: 2n } },
              { kind: "lit", value: { kind: "nat", value: 3n } },
            ],
          },
          {
            kind: "prim",
            target: 3,
            args: [{ kind: "lit", value: { kind: "nat", value: 4n } }],
          },
        ],
      }),
      prim(1, "Nat.add", 2),
      prim(2, "Nat.mul", 2),
      prim(3, "Nat.succ", 1),
    ]);

    const anf = toAnfProgram(source);
    const roundTripped = anfToMiniCoreProgram(anf);

    validateAnfProgram(anf);
    assert.strictEqual(
      valueToNat(evaluateMiniCore(roundTripped).value),
      valueToNat(evaluateMiniCore(source).value),
    );
  });

  it("is stable after ANF round-trip normalization", () => {
    const source = program([
      fn(0, "Main.main", 0, [], {
        kind: "prim",
        target: 1,
        args: [
          {
            kind: "prim",
            target: 2,
            args: [
              { kind: "lit", value: { kind: "nat", value: 2n } },
              { kind: "lit", value: { kind: "nat", value: 3n } },
            ],
          },
          {
            kind: "case",
            scrutinee: { kind: "con", target: 4, fields: [] },
            alts: [
              {
                constructor: 4,
                binders: [],
                body: {
                  kind: "prim",
                  target: 3,
                  args: [{ kind: "lit", value: { kind: "nat", value: 4n } }],
                },
              },
            ],
          },
        ],
      }),
      prim(1, "Nat.add", 2),
      prim(2, "Nat.mul", 2),
      prim(3, "Nat.succ", 1),
      ctor(4, "Main.Unit", 0, 0),
    ]);

    const once = toAnfProgram(source);
    const twice = toAnfProgram(anfToMiniCoreProgram(once));

    validateAnfProgram(twice);
    assert.strictEqual(unparseAnfProgram(twice), unparseAnfProgram(once));
  });

  it("documents strict left-to-right operand normalization", () => {
    const source = program([
      fn(0, "Main.main", 0, [], {
        kind: "call",
        target: 1,
        args: [
          { kind: "lit", value: { kind: "nat", value: 1n } },
          {
            kind: "call",
            target: 2,
            args: [],
          },
        ],
      }),
      fn(1, "Main.const", 2, [0, 1], { kind: "var", id: 0 }),
      fn(2, "Main.effect", 0, [], {
        kind: "lit",
        value: { kind: "nat", value: 2n },
      }),
    ]);

    const anf = toAnfProgram(source);

    validateAnfProgram(anf);
    assert.strictEqual(
      unparseAnfProgram(anf).split("\n\n")[0],
      [
        "Main.main =",
        "  let %0 = Main.effect",
        "  in",
        "  Main.const 1 %0",
      ].join("\n"),
    );
  });

  it("converts all ANF value forms back to MiniCore", () => {
    const source = program([
      fn(0, "Main.main", 0, [], {
        kind: "let",
        bindings: [
          { id: 0, value: { kind: "con", target: 2, fields: [] } },
          {
            id: 1,
            value: {
              kind: "case",
              scrutinee: { kind: "var", id: 0 },
              alts: [
                {
                  constructor: 2,
                  binders: [],
                  body: { kind: "call", target: 1, args: [] },
                },
              ],
            },
          },
        ],
        body: {
          kind: "prim",
          target: 3,
          args: [{ kind: "var", id: 1 }],
        },
      }),
      fn(1, "Main.one", 0, [], {
        kind: "lit",
        value: { kind: "nat", value: 1n },
      }),
      ctor(2, "Main.Unit", 0, 0),
      prim(3, "Nat.succ", 1),
    ]);

    const roundTripped = anfToMiniCoreProgram(toAnfProgram(source));

    assert.deepStrictEqual(
      evaluateMiniCore(roundTripped).value,
      evaluateMiniCore(source).value,
    );
  });

  it("unparses fallback symbol names and u8 literals", () => {
    const expr: AnfExpr = {
      kind: "prim",
      target: 99,
      args: [{ kind: "lit", value: { kind: "u8", value: 7 } }],
    };

    assert.strictEqual(unparseAnfExpr(expr), "#99 7u8");
  });

  it("rejects unbound atomic operands", () => {
    const invalid: AnfProgram = {
      entry: 0,
      symbolsByName: new Map([
        ["Main.main", 0],
        ["Nat.succ", 1],
      ]),
      symbols: [
        {
          kind: "function",
          id: 0,
          name: "Main.main",
          arity: 0,
          params: [],
          body: {
            kind: "prim",
            target: 1,
            args: [{ kind: "var", id: 0 }],
          },
        },
        prim(1, "Nat.succ", 1),
      ],
    };

    assert.throws(
      () => validateAnfProgram(invalid),
      (error) =>
        error instanceof MiniCoreAnfValidationError &&
        /Local variable 0 is unbound/.test(error.message),
    );
  });

  it("rejects malformed ANF program headers and symbols", () => {
    const main = fn(0, "Main.main", 0, [], {
      kind: "lit",
      value: { kind: "nat", value: 0n },
    });
    const anfMain = toAnfProgram(program([main]));

    assertAnfValidationError({ ...anfMain, entry: 7 }, /Entry symbol 7/);
    assertAnfValidationError(
      toAnfProgram(program([prim(0, "Nat.succ", 1)] as SymbolDef[])),
      /must be a function/,
    );
    assertAnfValidationError(
      toAnfProgram(
        program([fn(0, "Main.main", 1, [0], { kind: "var", id: 0 })]),
      ),
      /must have arity 0/,
    );
    assertAnfValidationError(
      toAnfProgram(program([{ ...main, id: 1 }])),
      /ID mismatch/,
    );
    assertAnfValidationError(
      { ...anfMain, symbolsByName: new Map() },
      /missing from symbolsByName/,
    );
    assertAnfValidationError(
      { ...anfMain, symbolsByName: new Map([["Main.main", 3]]) },
      /symbolsByName mismatch/,
    );
    assertAnfValidationError(
      toAnfProgram(program([main, { ...prim(1, "Nat.succ", 1), strict: [] }])),
      /arity\/strictness mismatch/,
    );
    assertAnfValidationError(
      toAnfProgram(program([main, ctor(1, "Main.Bad", 0, -1)])),
      /negative arity/,
    );
  });

  it("allows module validation without an executable entry", () => {
    const library = toAnfProgram(
      program([
        fn(0, "Main.id", 1, [0], { kind: "var", id: 0 }),
        fn(1, "Main.main", 0, [], {
          kind: "lit",
          value: { kind: "nat", value: 0n },
        }),
      ]),
    );

    validateAnfModule(library);
    assert.throws(
      () => validateAnfExecutable(library),
      (error) =>
        error instanceof MiniCoreAnfValidationError &&
        /must have arity 0/.test(error.message),
    );
  });

  it("rejects malformed ANF functions and lets", () => {
    assertAnfValidationError(
      toAnfProgram(
        program([
          fn(0, "Main.main", 0, [], {
            kind: "lit",
            value: { kind: "nat", value: 0n },
          }),
          fn(1, "Main.bad", -1, [], {
            kind: "lit",
            value: { kind: "nat", value: 0n },
          }),
        ]),
      ),
      /negative arity/,
    );
    assertAnfValidationError(
      toAnfProgram(
        program([fn(0, "Main.main", 0, [0], { kind: "var", id: 0 })]),
      ),
      /does not match params/,
    );
    assertAnfValidationError(
      toAnfProgram(
        program([
          fn(0, "Main.main", 0, [], {
            kind: "lit",
            value: { kind: "nat", value: 0n },
          }),
          fn(1, "Main.bad", 2, [0, 0], { kind: "var", id: 0 }),
        ]),
      ),
      /duplicate parameters/,
    );

    const invalid: AnfProgram = {
      entry: 0,
      symbolsByName: new Map([["Main.main", 0]]),
      symbols: [
        {
          kind: "function",
          id: 0,
          name: "Main.main",
          arity: 0,
          params: [],
          body: {
            kind: "let",
            id: 0,
            value: {
              kind: "atom",
              atom: { kind: "lit", value: { kind: "nat", value: 1n } },
            },
            body: {
              kind: "let",
              id: 0,
              value: {
                kind: "atom",
                atom: { kind: "lit", value: { kind: "nat", value: 2n } },
              },
              body: { kind: "atom", atom: { kind: "var", id: 0 } },
            },
          },
        },
      ],
    };

    assertAnfValidationError(invalid, /rebound/);
  });

  it("rejects malformed ANF calls, constructors, and primitives", () => {
    assertAnfValidationError(
      toAnfProgram(
        program([
          fn(0, "Main.main", 0, [], {
            kind: "call",
            target: 1,
            args: [],
          }),
          ctor(1, "Main.C", 0, 0),
        ]),
      ),
      /is not a function/,
    );
    assertAnfValidationError(
      toAnfProgram(
        program([
          fn(0, "Main.main", 0, [], {
            kind: "call",
            target: 1,
            args: [],
          }),
          fn(1, "Main.id", 1, [0], { kind: "var", id: 0 }),
        ]),
      ),
      /wrong arity/,
    );
    assertAnfValidationError(
      toAnfProgram(
        program([
          fn(0, "Main.main", 0, [], {
            kind: "con",
            target: 1,
            fields: [],
          }),
          prim(1, "Nat.succ", 1),
        ]),
      ),
      /is not a constructor/,
    );
    assertAnfValidationError(
      toAnfProgram(
        program([
          fn(0, "Main.main", 0, [], {
            kind: "con",
            target: 1,
            fields: [],
          }),
          ctor(1, "Main.C", 0, 1),
        ]),
      ),
      /wrong arity/,
    );
    assertAnfValidationError(
      toAnfProgram(
        program([
          fn(0, "Main.main", 0, [], {
            kind: "prim",
            target: 1,
            args: [],
          }),
          fn(1, "Main.id", 0, [], {
            kind: "lit",
            value: { kind: "nat", value: 0n },
          }),
        ]),
      ),
      /is not a primitive/,
    );
    assertAnfValidationError(
      toAnfProgram(
        program([
          fn(0, "Main.main", 0, [], {
            kind: "prim",
            target: 1,
            args: [],
          }),
          prim(1, "Nat.succ", 1),
        ]),
      ),
      /wrong arity/,
    );
  });

  it("rejects malformed ANF case alternatives", () => {
    assertAnfValidationError(
      toAnfProgram(
        program([
          fn(0, "Main.main", 0, [], {
            kind: "case",
            scrutinee: { kind: "con", target: 1, fields: [] },
            alts: [
              {
                constructor: 1,
                binders: [],
                body: { kind: "lit", value: { kind: "nat", value: 0n } },
              },
              {
                constructor: 1,
                binders: [],
                body: { kind: "lit", value: { kind: "nat", value: 1n } },
              },
            ],
          }),
          ctor(1, "Main.C", 0, 0),
        ]),
      ),
      /Duplicate constructor/,
    );
    assertAnfValidationError(
      toAnfProgram(
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
      ),
      /is not a constructor/,
    );
    assertAnfValidationError(
      toAnfProgram(
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
      ),
      /wrong binder count/,
    );
    assertAnfValidationError(
      toAnfProgram(
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
              {
                constructor: 1,
                binders: [0, 0],
                body: { kind: "var", id: 0 },
              },
            ],
          }),
          ctor(1, "Main.C", 0, 2),
        ]),
      ),
      /duplicate binders/,
    );

    const rebindsParam: AnfProgram = {
      entry: 0,
      symbolsByName: new Map([
        ["Main.main", 0],
        ["Main.C", 1],
      ]),
      symbols: [
        {
          kind: "function",
          id: 0,
          name: "Main.main",
          arity: 0,
          params: [],
          body: {
            kind: "let",
            id: 0,
            value: {
              kind: "atom",
              atom: { kind: "lit", value: { kind: "nat", value: 0n } },
            },
            body: {
              kind: "case",
              scrutinee: { kind: "var", id: 0 },
              alts: [
                {
                  constructor: 1,
                  binders: [0],
                  body: { kind: "atom", atom: { kind: "var", id: 0 } },
                },
              ],
            },
          },
        },
        ctor(1, "Main.C", 0, 1),
      ],
    };
    assertAnfValidationError(rebindsParam, /rebinds local 0/);
  });
});
