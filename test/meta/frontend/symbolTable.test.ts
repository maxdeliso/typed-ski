import { describe, it } from "../../util/test_shim.ts";
import assert from "node:assert/strict";
import {
  type DataDefinition,
  extractDefinitionValue,
  indexSymbols,
  type PolyDefinition,
  type TripLangProgram,
  type TypeDefinition,
} from "../../../lib/index.ts";
import { CompilationError } from "../../../lib/meta/frontend/errors.ts";
import { SKITerminalSymbol } from "../../../lib/ski/terminal.ts";

describe("Symbol Table", () => {
  it("should index a program with unique terms and types", () => {
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

    assert.ok(term !== undefined && term !== null);
    assert.ok(type !== undefined && type !== null);
    assert.deepStrictEqual(term, program.terms[0]);
    assert.deepStrictEqual(type, program.terms[1]);
  });

  it("should throw on duplicate term definitions", () => {
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

    assert.throws(() => indexSymbols(program), {
      name: "CompilationError",
      message: /Duplicate definition: id/,
    });
  });

  it("should throw on duplicate type definitions", () => {
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

    assert.throws(() => indexSymbols(program), {
      name: "CompilationError",
      message: /Duplicate type/,
    });
  });

  describe("should throw on duplicate definitions across different term kinds", () => {
    it("poly vs native", () => {
      const program: TripLangProgram = {
        kind: "program",
        terms: [
          {
            kind: "poly",
            name: "id",
            term: { kind: "systemF-var", name: "x" },
          },
          {
            kind: "native",
            name: "id",
            type: { kind: "type-var", typeName: "X" },
          },
        ],
      };

      assert.throws(() => indexSymbols(program), {
        name: "CompilationError",
        message: /Duplicate definition: id/,
      });
    });

    it("poly vs combinator", () => {
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

      assert.throws(() => indexSymbols(program), {
        name: "CompilationError",
        message: /Duplicate definition: id/,
      });
    });

    it("native vs combinator", () => {
      const program: TripLangProgram = {
        kind: "program",
        terms: [
          {
            kind: "native",
            name: "id",
            type: { kind: "type-var", typeName: "X" },
          },
          {
            kind: "combinator",
            name: "id",
            term: { kind: "terminal", sym: SKITerminalSymbol.I },
          },
        ],
      };

      assert.throws(() => indexSymbols(program), {
        name: "CompilationError",
        message: /Duplicate definition: id/,
      });
    });
  });

  it("should throw on duplicate data definitions", () => {
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

    assert.throws(() => indexSymbols(program), {
      name: "CompilationError",
      message: /Duplicate data definition: Option/,
    });
  });

  describe("should throw on duplicate constructor definitions", () => {
    it("duplicate constructor within same data type", () => {
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

      assert.throws(() => indexSymbols(program), {
        name: "CompilationError",
        message: /Duplicate constructor definition: Some/,
      });
    });

    it("duplicate constructor across different data types", () => {
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

      assert.throws(() => indexSymbols(program), {
        name: "CompilationError",
        message: /Duplicate constructor definition: Some/,
      });
    });
  });

  it("should index imported constructors with canonical declaration order", () => {
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
    assert.ok(errInfo !== undefined && errInfo !== null);
    assert.ok(okInfo !== undefined && okInfo !== null);
    assert.ok(noneInfo !== undefined && noneInfo !== null);
    assert.ok(someInfo !== undefined && someInfo !== null);

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
    assert.ok(resultData !== undefined && resultData !== null);
    assert.ok(maybeData !== undefined && maybeData !== null);
    assert.deepStrictEqual(
      resultData!.constructors.map((ctor) => ctor.name),
      ["Err", "Ok"],
    );
    assert.deepStrictEqual(
      maybeData!.constructors.map((ctor) => ctor.name),
      ["None", "Some"],
    );
  });

  it("should index imported metadata from plain-object options and clone complex field shapes", () => {
    const complexData: DataDefinition = {
      kind: "data",
      name: "Complex",
      typeParams: ["A"],
      constructors: [
        {
          name: "MkComplex",
          fields: [
            { kind: "type-var", typeName: "A" },
            {
              kind: "type-app",
              fn: { kind: "type-var", typeName: "List" },
              arg: { kind: "type-var", typeName: "A" },
            },
            {
              kind: "forall",
              typeVar: "T",
              body: { kind: "type-var", typeName: "T" },
            },
            {
              kind: "non-terminal",
              lft: { kind: "type-var", typeName: "A" },
              rgt: { kind: "type-var", typeName: "A" },
            },
          ],
        },
      ],
    };

    const program: TripLangProgram = {
      kind: "program",
      terms: [
        { kind: "module", name: "M" },
        { kind: "import", name: "Remote", ref: "Complex" },
        { kind: "import", name: "Remote", ref: "MkComplex" },
      ],
    };

    const symbols = indexSymbols(program, {
      importedDataDefinitionsByModule: {
        Remote: [complexData],
      },
    });

    const ctorInfo = symbols.constructors.get("MkComplex");
    assert.ok(ctorInfo !== undefined && ctorInfo !== null);
    assert.strictEqual(ctorInfo!.dataName, "Complex");
    assert.strictEqual(ctorInfo!.index, 0);
    assert.deepStrictEqual(
      ctorInfo!.constructor.fields,
      complexData.constructors[0]!.fields,
    );
    assert.notStrictEqual(
      ctorInfo!.constructor.fields,
      complexData.constructors[0]!.fields,
    );

    // Importing the type name should register data metadata without creating a constructor entry.
    assert.ok(symbols.data.has("Complex"));
    assert.strictEqual(symbols.constructors.get("Complex"), undefined);
  });

  it("should preserve local constructors and allow duplicate imported constructors", () => {
    const importedMaybe: DataDefinition = {
      kind: "data",
      name: "Maybe",
      typeParams: ["A"],
      constructors: [
        { name: "None", fields: [] },
        { name: "Some", fields: [{ kind: "type-var", typeName: "A" }] },
      ],
    };

    const program: TripLangProgram = {
      kind: "program",
      terms: [
        { kind: "module", name: "M" },
        { kind: "import", name: "Prelude", ref: "Some" },
        { kind: "import", name: "Prelude", ref: "Some" },
        {
          kind: "data",
          name: "LocalOption",
          typeParams: ["A"],
          constructors: [
            { name: "Some", fields: [{ kind: "type-var", typeName: "A" }] },
            { name: "NoneLocal", fields: [] },
          ],
        },
      ],
    };

    const symbols = indexSymbols(program, {
      importedDataDefinitionsByModule: new Map([["Prelude", [importedMaybe]]]),
    });

    const someInfo = symbols.constructors.get("Some");
    assert.ok(someInfo !== undefined && someInfo !== null);
    assert.strictEqual(someInfo!.dataName, "LocalOption");
    assert.strictEqual(someInfo!.index, 0);
  });

  it("should resolve poly term definition", () => {
    const term: PolyDefinition = {
      kind: "poly",
      name: "id",
      term: { kind: "systemF-var", name: "x" },
    };

    const resolved = extractDefinitionValue(term);
    assert.deepStrictEqual(resolved, { kind: "systemF-var", name: "x" });
  });

  it("should resolve type definition", () => {
    const term: TypeDefinition = {
      kind: "type",
      name: "Nat",
      type: { kind: "type-var", typeName: "X" },
    };

    const resolved = extractDefinitionValue(term);
    assert.deepStrictEqual(resolved, { kind: "type-var", typeName: "X" });
  });
});
