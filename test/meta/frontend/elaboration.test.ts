import { describe, it } from "../../util/test_shim.ts";
import assert from "node:assert/strict";
import { elaborateSystemF } from "../../../lib/meta/frontend/elaboration.ts";
import { CompilationError } from "../../../lib/meta/frontend/errors.ts";
import { indexSymbols } from "../../../lib/meta/frontend/symbolTable.ts";
import type { DataDefinition, SymbolTable } from "../../../lib/meta/trip.ts";
import { parseTripLang } from "../../../lib/parser/tripLang.ts";
import {
  mkSystemFAbs,
  mkSystemFTAbs,
  mkSystemFTypeApp,
  mkSystemFVar,
  type SystemFTerm,
} from "../../../lib/terms/systemF.ts";
import { mkSystemFApp } from "../../util/ast.ts";
import {
  arrow,
  type BaseType,
  mkTypeVariable,
} from "../../../lib/types/types.ts";

describe("elaborateSystemF", () => {
  function createSymbolTable(
    types: { name: string; type: BaseType }[],
  ): SymbolTable {
    const table: SymbolTable = {
      terms: new Map(),
      types: new Map(),
      data: new Map(),
      constructors: new Map(),
      imports: new Set(),
    };

    for (const { name, type } of types) {
      table.types.set(name, { kind: "type", name, type });
    }

    return table;
  }

  const preludeDataDefinitions: DataDefinition[] = [
    {
      kind: "data",
      name: "Result",
      typeParams: ["E", "T"],
      constructors: [
        { name: "Err", fields: [{ kind: "type-var", typeName: "E" }] },
        { name: "Ok", fields: [{ kind: "type-var", typeName: "T" }] },
      ],
    },
  ];

  it("should rewrite term applications as type applications when right-hand side is a type", () => {
    const syms = createSymbolTable([
      { name: "T", type: { kind: "type-var", typeName: "T" } },
    ]);

    // Create expression: x T
    const expr = mkSystemFApp(mkSystemFVar("x"), mkSystemFVar("T"));

    const result = elaborateSystemF(expr, syms);

    assert.deepStrictEqual(
      result,
      mkSystemFTypeApp(mkSystemFVar("x"), {
        kind: "type-var",
        typeName: "T",
      }),
    );
  });

  it("should handle nested type applications", () => {
    const syms = createSymbolTable([
      { name: "T", type: { kind: "type-var", typeName: "T" } },
      { name: "U", type: { kind: "type-var", typeName: "U" } },
    ]);

    // Create expression: (x T) U
    const expr = mkSystemFApp(
      mkSystemFApp(mkSystemFVar("x"), mkSystemFVar("T")),
      mkSystemFVar("U"),
    );

    const result = elaborateSystemF(expr, syms);

    assert.deepStrictEqual(
      result,
      mkSystemFTypeApp(
        mkSystemFTypeApp(mkSystemFVar("x"), {
          kind: "type-var",
          typeName: "T",
        }),
        { kind: "type-var", typeName: "U" },
      ),
    );
  });

  it("should not rewrite applications when right-hand side is not a type", () => {
    const syms = createSymbolTable([
      { name: "T", type: { kind: "type-var", typeName: "T" } },
    ]);

    // Create expression: x y
    const expr = mkSystemFApp(mkSystemFVar("x"), mkSystemFVar("y"));

    const result = elaborateSystemF(expr, syms);

    assert.deepStrictEqual(
      result,
      mkSystemFApp(mkSystemFVar("x"), mkSystemFVar("y")),
    );
  });

  it("should handle mixed type and term applications", () => {
    const syms = createSymbolTable([
      { name: "T", type: { kind: "type-var", typeName: "T" } },
    ]);

    // Create expression: (x T) y
    const expr = mkSystemFApp(
      mkSystemFApp(mkSystemFVar("x"), mkSystemFVar("T")),
      mkSystemFVar("y"),
    );

    const result = elaborateSystemF(expr, syms);

    assert.deepStrictEqual(
      result,
      mkSystemFApp(
        mkSystemFTypeApp(mkSystemFVar("x"), {
          kind: "type-var",
          typeName: "T",
        }),
        mkSystemFVar("y"),
      ),
    );
  });

  it("should handle type abstractions correctly", () => {
    const syms = createSymbolTable([
      { name: "T", type: { kind: "type-var", typeName: "T" } },
    ]);

    // Create expression: ΛX. x T
    const expr = mkSystemFTAbs(
      "X",
      mkSystemFApp(mkSystemFVar("x"), mkSystemFVar("T")),
    );

    const result = elaborateSystemF(expr, syms);

    assert.deepStrictEqual(
      result,
      mkSystemFTAbs(
        "X",
        mkSystemFTypeApp(mkSystemFVar("x"), {
          kind: "type-var",
          typeName: "T",
        }),
      ),
    );
  });

  it("should handle polymorphic successor function correctly", () => {
    const syms = createSymbolTable([
      { name: "X", type: { kind: "type-var", typeName: "X" } },
    ]);

    // Create expression: λn:Nat.ΛX.λs:(X→X).λz:X.(s (n[X] s z))
    const expr = mkSystemFAbs(
      "n",
      { kind: "type-var", typeName: "Nat" },
      mkSystemFTAbs(
        "X",
        mkSystemFAbs(
          "s",
          arrow(
            { kind: "type-var", typeName: "X" },
            { kind: "type-var", typeName: "X" },
          ),
          mkSystemFAbs(
            "z",
            { kind: "type-var", typeName: "X" },
            mkSystemFApp(
              mkSystemFVar("s"),
              mkSystemFApp(
                mkSystemFTypeApp(mkSystemFVar("n"), {
                  kind: "type-var",
                  typeName: "X",
                }),
                mkSystemFApp(mkSystemFVar("s"), mkSystemFVar("z")),
              ),
            ),
          ),
        ),
      ),
    );

    const result = elaborateSystemF(expr, syms);

    assert.deepStrictEqual(
      result,
      mkSystemFAbs(
        "n",
        { kind: "type-var", typeName: "Nat" },
        mkSystemFTAbs(
          "X",
          mkSystemFAbs(
            "s",
            arrow(
              { kind: "type-var", typeName: "X" },
              { kind: "type-var", typeName: "X" },
            ),
            mkSystemFAbs(
              "z",
              { kind: "type-var", typeName: "X" },
              mkSystemFApp(
                mkSystemFVar("s"),
                mkSystemFApp(
                  mkSystemFTypeApp(mkSystemFVar("n"), {
                    kind: "type-var",
                    typeName: "X",
                  }),
                  mkSystemFApp(mkSystemFVar("s"), mkSystemFVar("z")),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  });

  it("should canonicalize imported constructor match arms by declaration order", () => {
    const src = `
module ImportedMatchOrder
import Prelude Result
import Prelude Ok
import Prelude Err
import Prelude Bool
import Prelude false
poly pick = match x [Bool] { | Ok v => v | Err e => false }
      `;

    const program = parseTripLang(src);
    const syms = indexSymbols(program, {
      importedDataDefinitionsByModule: new Map([
        ["Prelude", preludeDataDefinitions],
      ]),
    });
    const pick = program.terms.find(
      (term) => term.kind === "poly" && term.name === "pick",
    );
    if (!pick || pick.kind !== "poly") {
      throw new Error("expected poly pick");
    }

    const elaborated = elaborateSystemF(pick.term, syms);
    const expected = mkSystemFApp(
      mkSystemFApp(
        mkSystemFTypeApp(mkSystemFVar("x"), mkTypeVariable("Bool")),
        mkSystemFAbs("e", mkTypeVariable("E"), mkSystemFVar("false")),
      ),
      mkSystemFAbs("v", mkTypeVariable("T"), mkSystemFVar("v")),
    );

    assert.deepStrictEqual(elaborated, expected);
  });

  it("should reject non-exhaustive match on imported built-in constructors", () => {
    const src = `
module ImportedMatchMissing
import Prelude Result
import Prelude Ok
import Prelude Bool
poly pick = match x [Bool] { | Ok v => v }
      `;

    const program = parseTripLang(src);
    const syms = indexSymbols(program, {
      importedDataDefinitionsByModule: new Map([
        ["Prelude", preludeDataDefinitions],
      ]),
    });
    const pick = program.terms.find(
      (term) => term.kind === "poly" && term.name === "pick",
    );
    if (!pick || pick.kind !== "poly") {
      throw new Error("expected poly pick");
    }

    assert.throws(
      () => {
        elaborateSystemF(pick.term, syms);
      },
      CompilationError,
      "match is missing constructors: Err",
    );
  });

  describe("elaborateMatch error cases", () => {
    function createSymbolTableWithData(
      dataDefs: DataDefinition[],
    ): SymbolTable {
      const table: SymbolTable = {
        terms: new Map(),
        types: new Map(),
        data: new Map(),
        constructors: new Map(),
        imports: new Set(),
      };

      for (const dataDef of dataDefs) {
        table.data.set(dataDef.name, dataDef);
        dataDef.constructors.forEach((ctor, index) => {
          table.constructors.set(ctor.name, {
            dataName: dataDef.name,
            index,
            constructor: ctor,
          });
        });
      }

      return table;
    }

    function createMatch(
      scrutinee: SystemFTerm,
      returnType: BaseType,
      arms: { constructorName: string; params: string[]; body: SystemFTerm }[],
    ): SystemFTerm {
      return {
        kind: "systemF-match",
        scrutinee,
        returnType,
        arms,
      };
    }

    it("should throw error when match has no arms", () => {
      const syms = createSymbolTableWithData([]);
      const match = createMatch(
        mkSystemFVar("x"),
        { kind: "type-var", typeName: "T" },
        [],
      );

      assert.throws(
        () => {
          elaborateSystemF(match, syms);
        },
        CompilationError,
        "match must declare at least one arm",
      );
    });

    it("should throw error for unknown constructor", () => {
      const syms = createSymbolTableWithData([
        {
          kind: "data",
          name: "Option",
          typeParams: ["T"],
          constructors: [
            { name: "Some", fields: [{ kind: "type-var", typeName: "T" }] },
            { name: "None", fields: [] },
          ],
        },
      ]);

      const match = createMatch(
        mkSystemFVar("x"),
        { kind: "type-var", typeName: "T" },
        [
          {
            constructorName: "UnknownCtor",
            params: [],
            body: mkSystemFVar("y"),
          },
        ],
      );

      assert.throws(
        () => {
          elaborateSystemF(match, syms);
        },
        CompilationError,
        "Unknown constructor 'UnknownCtor' in match",
      );
    });

    it("should throw error when match arms target different data types", () => {
      const syms = createSymbolTableWithData([
        {
          kind: "data",
          name: "Option",
          typeParams: ["T"],
          constructors: [
            { name: "Some", fields: [{ kind: "type-var", typeName: "T" }] },
            { name: "None", fields: [] },
          ],
        },
        {
          kind: "data",
          name: "Result",
          typeParams: ["T", "E"],
          constructors: [
            {
              name: "Ok",
              fields: [{ kind: "type-var", typeName: "T" }],
            },
            {
              name: "Err",
              fields: [{ kind: "type-var", typeName: "E" }],
            },
          ],
        },
      ]);

      const match = createMatch(
        mkSystemFVar("x"),
        { kind: "type-var", typeName: "T" },
        [
          {
            constructorName: "Some",
            params: ["val"],
            body: mkSystemFVar("val"),
          },
          {
            constructorName: "Ok",
            params: ["val"],
            body: mkSystemFVar("val"),
          },
        ],
      );

      assert.throws(
        () => {
          elaborateSystemF(match, syms);
        },
        CompilationError,
        "match arms must all target the same data type",
      );
    });

    it("should throw error when data definition is missing", () => {
      const syms: SymbolTable = {
        terms: new Map(),
        types: new Map(),
        data: new Map(), // Empty - no data definitions
        constructors: new Map([
          [
            "Some",
            {
              dataName: "Option",
              index: 0,
              constructor: {
                name: "Some",
                fields: [{ kind: "type-var", typeName: "T" }],
              },
            },
          ],
        ]),
        imports: new Set(),
      };

      const match = createMatch(
        mkSystemFVar("x"),
        { kind: "type-var", typeName: "T" },
        [
          {
            constructorName: "Some",
            params: ["val"],
            body: mkSystemFVar("val"),
          },
        ],
      );

      assert.throws(
        () => {
          elaborateSystemF(match, syms);
        },
        CompilationError,
        "Missing data definition for Option",
      );
    });

    it("should throw error for duplicate match arm", () => {
      const syms = createSymbolTableWithData([
        {
          kind: "data",
          name: "Option",
          typeParams: ["T"],
          constructors: [
            { name: "Some", fields: [{ kind: "type-var", typeName: "T" }] },
            { name: "None", fields: [] },
          ],
        },
      ]);

      const match = createMatch(
        mkSystemFVar("x"),
        { kind: "type-var", typeName: "T" },
        [
          {
            constructorName: "Some",
            params: ["val"],
            body: mkSystemFVar("val"),
          },
          {
            constructorName: "Some",
            params: ["val2"],
            body: mkSystemFVar("val2"),
          },
        ],
      );

      assert.throws(
        () => {
          elaborateSystemF(match, syms);
        },
        CompilationError,
        "Duplicate match arm for constructor 'Some'",
      );
    });

    it("should throw error when match is missing constructors", () => {
      const syms = createSymbolTableWithData([
        {
          kind: "data",
          name: "Option",
          typeParams: ["T"],
          constructors: [
            { name: "Some", fields: [{ kind: "type-var", typeName: "T" }] },
            { name: "None", fields: [] },
          ],
        },
      ]);

      const match = createMatch(
        mkSystemFVar("x"),
        { kind: "type-var", typeName: "T" },
        [
          {
            constructorName: "Some",
            params: ["val"],
            body: mkSystemFVar("val"),
          },
          // Missing "None" arm
        ],
      );

      assert.throws(
        () => {
          elaborateSystemF(match, syms);
        },
        CompilationError,
        "match is missing constructors: None",
      );
    });

    it("should throw error when constructor parameter count doesn't match", () => {
      const syms = createSymbolTableWithData([
        {
          kind: "data",
          name: "Option",
          typeParams: ["T"],
          constructors: [
            { name: "Some", fields: [{ kind: "type-var", typeName: "T" }] },
            { name: "None", fields: [] },
          ],
        },
      ]);

      const match = createMatch(
        mkSystemFVar("x"),
        { kind: "type-var", typeName: "T" },
        [
          {
            constructorName: "Some",
            params: [], // Wrong: Some expects 1 parameter
            body: mkSystemFVar("y"),
          },
          {
            constructorName: "None",
            params: [],
            body: mkSystemFVar("z"),
          },
        ],
      );

      assert.throws(
        () => {
          elaborateSystemF(match, syms);
        },
        CompilationError,
        "Constructor 'Some' expects 1 parameter(s)",
      );
    });

    it("should throw error when constructor has too many parameters", () => {
      const syms = createSymbolTableWithData([
        {
          kind: "data",
          name: "Option",
          typeParams: ["T"],
          constructors: [
            { name: "Some", fields: [{ kind: "type-var", typeName: "T" }] },
            { name: "None", fields: [] },
          ],
        },
      ]);

      const match = createMatch(
        mkSystemFVar("x"),
        { kind: "type-var", typeName: "T" },
        [
          {
            constructorName: "Some",
            params: ["val", "extra"], // Wrong: Some expects only 1 parameter
            body: mkSystemFVar("val"),
          },
          {
            constructorName: "None",
            params: [],
            body: mkSystemFVar("z"),
          },
        ],
      );

      assert.throws(
        () => {
          elaborateSystemF(match, syms);
        },
        CompilationError,
        "Constructor 'Some' expects 1 parameter(s)",
      );
    });

    it("should throw error when match is missing multiple constructors", () => {
      const syms = createSymbolTableWithData([
        {
          kind: "data",
          name: "Triple",
          typeParams: ["T"],
          constructors: [
            { name: "First", fields: [{ kind: "type-var", typeName: "T" }] },
            { name: "Second", fields: [{ kind: "type-var", typeName: "T" }] },
            { name: "Third", fields: [{ kind: "type-var", typeName: "T" }] },
          ],
        },
      ]);

      const match = createMatch(
        mkSystemFVar("x"),
        { kind: "type-var", typeName: "T" },
        [
          {
            constructorName: "First",
            params: ["val"],
            body: mkSystemFVar("val"),
          },
          // Missing Second and Third
        ],
      );

      assert.throws(
        () => {
          elaborateSystemF(match, syms);
        },
        CompilationError,
        "match is missing constructors: Second, Third",
      );
    });
  });
});
