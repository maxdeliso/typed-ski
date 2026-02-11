import { assert } from "chai";
import {
  type DataDefinition,
  extractDefinitionValue,
  indexSymbols,
  type PolyDefinition,
  type TripLangProgram,
  type TypedDefinition,
  type TypeDefinition,
} from "../../../lib/index.ts";
import { CompilationError } from "../../../lib/meta/frontend/errors.ts";
import { SKITerminalSymbol } from "../../../lib/ski/terminal.ts";

Deno.test("Symbol Table", async (t) => {
  await t.step("should index a program with unique terms and types", () => {
    const program: TripLangProgram = {
      kind: "program",
      terms: [
        {
          kind: "poly",
          name: "id",
          term: { kind: "systemF-var", name: "x" },
        },
        {
          kind: "type",
          name: "Nat",
          type: { kind: "type-var", typeName: "X" },
        },
      ],
    };

    const symbols = indexSymbols(program);
    const term = symbols.terms.get("id");
    const type = symbols.types.get("Nat");

    assert.isDefined(term);
    assert.isDefined(type);
    assert.deepStrictEqual(term, program.terms[0]);
    assert.deepStrictEqual(type, program.terms[1]);
  });

  await t.step("should throw on duplicate term definitions", () => {
    const program: TripLangProgram = {
      kind: "program",
      terms: [
        {
          kind: "poly",
          name: "id",
          term: { kind: "systemF-var", name: "x" },
        },
        {
          kind: "poly",
          name: "id",
          term: { kind: "systemF-var", name: "y" },
        },
      ],
    };

    assert.throws(
      () => indexSymbols(program),
      CompilationError,
      "Duplicate definition: id",
    );
  });

  await t.step("should throw on duplicate type definitions", () => {
    const program: TripLangProgram = {
      kind: "program",
      terms: [
        {
          kind: "type",
          name: "Nat",
          type: { kind: "type-var", typeName: "X" },
        },
        {
          kind: "type",
          name: "Nat",
          type: { kind: "type-var", typeName: "Y" },
        },
      ],
    };

    assert.throws(
      () => indexSymbols(program),
      CompilationError,
      "Duplicate type",
    );
  });

  await t.step(
    "should throw on duplicate definitions across different term kinds",
    async (t) => {
      await t.step("poly vs typed", () => {
        const program: TripLangProgram = {
          kind: "program",
          terms: [
            {
              kind: "poly",
              name: "id",
              term: { kind: "systemF-var", name: "x" },
            },
            {
              kind: "typed",
              name: "id",
              term: { kind: "lambda-var", name: "x" },
            },
          ],
        };

        assert.throws(
          () => indexSymbols(program),
          CompilationError,
          "Duplicate definition: id",
        );
      });

      await t.step("poly vs untyped", () => {
        const program: TripLangProgram = {
          kind: "program",
          terms: [
            {
              kind: "poly",
              name: "id",
              term: { kind: "systemF-var", name: "x" },
            },
            {
              kind: "untyped",
              name: "id",
              term: { kind: "lambda-var", name: "x" },
            },
          ],
        };

        assert.throws(
          () => indexSymbols(program),
          CompilationError,
          "Duplicate definition: id",
        );
      });

      await t.step("poly vs combinator", () => {
        const program: TripLangProgram = {
          kind: "program",
          terms: [
            {
              kind: "poly",
              name: "id",
              term: { kind: "systemF-var", name: "x" },
            },
            {
              kind: "combinator",
              name: "id",
              term: { kind: "terminal", sym: SKITerminalSymbol.I },
            },
          ],
        };

        assert.throws(
          () => indexSymbols(program),
          CompilationError,
          "Duplicate definition: id",
        );
      });

      await t.step("typed vs untyped", () => {
        const program: TripLangProgram = {
          kind: "program",
          terms: [
            {
              kind: "typed",
              name: "id",
              term: { kind: "lambda-var", name: "x" },
            },
            {
              kind: "untyped",
              name: "id",
              term: { kind: "lambda-var", name: "x" },
            },
          ],
        };

        assert.throws(
          () => indexSymbols(program),
          CompilationError,
          "Duplicate definition: id",
        );
      });

      await t.step("typed vs combinator", () => {
        const program: TripLangProgram = {
          kind: "program",
          terms: [
            {
              kind: "typed",
              name: "id",
              term: { kind: "lambda-var", name: "x" },
            },
            {
              kind: "combinator",
              name: "id",
              term: { kind: "terminal", sym: SKITerminalSymbol.I },
            },
          ],
        };

        assert.throws(
          () => indexSymbols(program),
          CompilationError,
          "Duplicate definition: id",
        );
      });

      await t.step("untyped vs combinator", () => {
        const program: TripLangProgram = {
          kind: "program",
          terms: [
            {
              kind: "untyped",
              name: "id",
              term: { kind: "lambda-var", name: "x" },
            },
            {
              kind: "combinator",
              name: "id",
              term: { kind: "terminal", sym: SKITerminalSymbol.I },
            },
          ],
        };

        assert.throws(
          () => indexSymbols(program),
          CompilationError,
          "Duplicate definition: id",
        );
      });
    },
  );

  await t.step("should throw on duplicate data definitions", () => {
    const program: TripLangProgram = {
      kind: "program",
      terms: [
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
          name: "Option",
          typeParams: ["T"],
          constructors: [
            { name: "Just", fields: [{ kind: "type-var", typeName: "T" }] },
            { name: "Nothing", fields: [] },
          ],
        },
      ],
    };

    assert.throws(
      () => indexSymbols(program),
      CompilationError,
      "Duplicate data definition: Option",
    );
  });

  await t.step(
    "should throw on duplicate constructor definitions",
    async (t) => {
      await t.step("duplicate constructor within same data type", () => {
        const program: TripLangProgram = {
          kind: "program",
          terms: [
            {
              kind: "data",
              name: "Option",
              typeParams: ["T"],
              constructors: [
                { name: "Some", fields: [{ kind: "type-var", typeName: "T" }] },
                { name: "Some", fields: [{ kind: "type-var", typeName: "T" }] }, // Duplicate
                { name: "None", fields: [] },
              ],
            },
          ],
        };

        assert.throws(
          () => indexSymbols(program),
          CompilationError,
          "Duplicate constructor definition: Some",
        );
      });

      await t.step("duplicate constructor across different data types", () => {
        const program: TripLangProgram = {
          kind: "program",
          terms: [
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
                { name: "Some", fields: [{ kind: "type-var", typeName: "T" }] }, // Duplicate
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
          ],
        };

        assert.throws(
          () => indexSymbols(program),
          CompilationError,
          "Duplicate constructor definition: Some",
        );
      });
    },
  );

  await t.step(
    "should index imported constructors with canonical declaration order",
    () => {
      const program: TripLangProgram = {
        kind: "program",
        terms: [
          { kind: "module", name: "M" },
          { kind: "import", name: "Prelude", ref: "Result" },
          { kind: "import", name: "Prelude", ref: "Err" },
          { kind: "import", name: "Prelude", ref: "Ok" },
          { kind: "import", name: "Prelude", ref: "Maybe" },
          { kind: "import", name: "Prelude", ref: "Some" },
          { kind: "import", name: "Prelude", ref: "None" },
        ],
      };

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
        {
          kind: "data",
          name: "Maybe",
          typeParams: ["A"],
          constructors: [
            { name: "None", fields: [] },
            { name: "Some", fields: [{ kind: "type-var", typeName: "A" }] },
          ],
        },
      ];

      const symbols = indexSymbols(program, {
        importedDataDefinitionsByModule: new Map([
          ["Prelude", preludeDataDefinitions],
        ]),
      });

      const errInfo = symbols.constructors.get("Err");
      const okInfo = symbols.constructors.get("Ok");
      const noneInfo = symbols.constructors.get("None");
      const someInfo = symbols.constructors.get("Some");
      assert.isDefined(errInfo);
      assert.isDefined(okInfo);
      assert.isDefined(noneInfo);
      assert.isDefined(someInfo);

      assert.strictEqual(errInfo!.dataName, "Result");
      assert.strictEqual(errInfo!.index, 0);
      assert.strictEqual(okInfo!.dataName, "Result");
      assert.strictEqual(okInfo!.index, 1);

      assert.strictEqual(noneInfo!.dataName, "Maybe");
      assert.strictEqual(noneInfo!.index, 0);
      assert.strictEqual(someInfo!.dataName, "Maybe");
      assert.strictEqual(someInfo!.index, 1);

      const resultData = symbols.data.get("Result");
      const maybeData = symbols.data.get("Maybe");
      assert.isDefined(resultData);
      assert.isDefined(maybeData);
      assert.deepStrictEqual(
        resultData!.constructors.map((ctor) => ctor.name),
        ["Err", "Ok"],
      );
      assert.deepStrictEqual(
        maybeData!.constructors.map((ctor) => ctor.name),
        ["None", "Some"],
      );
    },
  );

  await t.step("should resolve poly term definition", () => {
    const term: PolyDefinition = {
      kind: "poly",
      name: "id",
      term: { kind: "systemF-var", name: "x" },
    };

    const resolved = extractDefinitionValue(term);
    assert.deepStrictEqual(resolved, { kind: "systemF-var", name: "x" });
  });

  await t.step("should resolve typed term definition", () => {
    const term: TypedDefinition = {
      kind: "typed",
      name: "id",
      type: { kind: "type-var", typeName: "X" },
      term: { kind: "lambda-var", name: "x" },
    };

    const resolved = extractDefinitionValue(term);
    assert.deepStrictEqual(resolved, { kind: "lambda-var", name: "x" });
  });

  await t.step("should resolve type definition", () => {
    const term: TypeDefinition = {
      kind: "type",
      name: "Nat",
      type: { kind: "type-var", typeName: "X" },
    };

    const resolved = extractDefinitionValue(term);
    assert.deepStrictEqual(resolved, { kind: "type-var", typeName: "X" });
  });
});
