import { expect } from "chai";
import { elaborateSystemF } from "../../../lib/meta/frontend/elaboration.ts";
import { CompilationError } from "../../../lib/meta/frontend/errors.ts";
import type { DataDefinition, SymbolTable } from "../../../lib/meta/trip.ts";
import {
  mkSystemFAbs,
  mkSystemFApp,
  mkSystemFTAbs,
  mkSystemFTypeApp,
  mkSystemFVar,
  type SystemFTerm,
} from "../../../lib/terms/systemF.ts";
import { arrow, type BaseType } from "../../../lib/types/types.ts";

Deno.test("elaborateSystemF", async (t) => {
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

  await t.step(
    "should rewrite term applications as type applications when right-hand side is a type",
    () => {
      const syms = createSymbolTable([
        { name: "T", type: { kind: "type-var", typeName: "T" } },
      ]);

      // Create expression: x T
      const expr = mkSystemFApp(
        mkSystemFVar("x"),
        mkSystemFVar("T"),
      );

      const result = elaborateSystemF(expr, syms);

      expect(result).to.deep.equal(
        mkSystemFTypeApp(
          mkSystemFVar("x"),
          { kind: "type-var", typeName: "T" },
        ),
      );
    },
  );

  await t.step("should handle nested type applications", () => {
    const syms = createSymbolTable([
      { name: "T", type: { kind: "type-var", typeName: "T" } },
      { name: "U", type: { kind: "type-var", typeName: "U" } },
    ]);

    // Create expression: (x T) U
    const expr = mkSystemFApp(
      mkSystemFApp(
        mkSystemFVar("x"),
        mkSystemFVar("T"),
      ),
      mkSystemFVar("U"),
    );

    const result = elaborateSystemF(expr, syms);

    expect(result).to.deep.equal(
      mkSystemFTypeApp(
        mkSystemFTypeApp(
          mkSystemFVar("x"),
          { kind: "type-var", typeName: "T" },
        ),
        { kind: "type-var", typeName: "U" },
      ),
    );
  });

  await t.step(
    "should not rewrite applications when right-hand side is not a type",
    () => {
      const syms = createSymbolTable([
        { name: "T", type: { kind: "type-var", typeName: "T" } },
      ]);

      // Create expression: x y
      const expr = mkSystemFApp(
        mkSystemFVar("x"),
        mkSystemFVar("y"),
      );

      const result = elaborateSystemF(expr, syms);

      expect(result).to.deep.equal(
        mkSystemFApp(
          mkSystemFVar("x"),
          mkSystemFVar("y"),
        ),
      );
    },
  );

  await t.step("should handle mixed type and term applications", () => {
    const syms = createSymbolTable([
      { name: "T", type: { kind: "type-var", typeName: "T" } },
    ]);

    // Create expression: (x T) y
    const expr = mkSystemFApp(
      mkSystemFApp(
        mkSystemFVar("x"),
        mkSystemFVar("T"),
      ),
      mkSystemFVar("y"),
    );

    const result = elaborateSystemF(expr, syms);

    expect(result).to.deep.equal(
      mkSystemFApp(
        mkSystemFTypeApp(
          mkSystemFVar("x"),
          { kind: "type-var", typeName: "T" },
        ),
        mkSystemFVar("y"),
      ),
    );
  });

  await t.step("should handle type abstractions correctly", () => {
    const syms = createSymbolTable([
      { name: "T", type: { kind: "type-var", typeName: "T" } },
    ]);

    // Create expression: ΛX. x T
    const expr = mkSystemFTAbs(
      "X",
      mkSystemFApp(
        mkSystemFVar("x"),
        mkSystemFVar("T"),
      ),
    );

    const result = elaborateSystemF(expr, syms);

    expect(result).to.deep.equal(
      mkSystemFTAbs(
        "X",
        mkSystemFTypeApp(
          mkSystemFVar("x"),
          { kind: "type-var", typeName: "T" },
        ),
      ),
    );
  });

  await t.step("should handle polymorphic successor function correctly", () => {
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
                mkSystemFTypeApp(
                  mkSystemFVar("n"),
                  { kind: "type-var", typeName: "X" },
                ),
                mkSystemFApp(
                  mkSystemFVar("s"),
                  mkSystemFVar("z"),
                ),
              ),
            ),
          ),
        ),
      ),
    );

    const result = elaborateSystemF(expr, syms);

    expect(result).to.deep.equal(
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
                  mkSystemFTypeApp(
                    mkSystemFVar("n"),
                    { kind: "type-var", typeName: "X" },
                  ),
                  mkSystemFApp(
                    mkSystemFVar("s"),
                    mkSystemFVar("z"),
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  });

  await t.step("elaborateMatch error cases", async (t) => {
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

    await t.step(
      "should throw error when match has no arms",
      () => {
        const syms = createSymbolTableWithData([]);
        const match = createMatch(
          mkSystemFVar("x"),
          { kind: "type-var", typeName: "T" },
          [],
        );

        expect(() => {
          elaborateSystemF(match, syms);
        }).to.throw(CompilationError, "match must declare at least one arm");
      },
    );

    await t.step(
      "should throw error for unknown constructor",
      () => {
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

        expect(() => {
          elaborateSystemF(match, syms);
        }).to.throw(
          CompilationError,
          "Unknown constructor 'UnknownCtor' in match",
        );
      },
    );

    await t.step(
      "should throw error when match arms target different data types",
      () => {
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

        expect(() => {
          elaborateSystemF(match, syms);
        }).to.throw(
          CompilationError,
          "match arms must all target the same data type",
        );
      },
    );

    await t.step(
      "should throw error when data definition is missing",
      () => {
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

        expect(() => {
          elaborateSystemF(match, syms);
        }).to.throw(CompilationError, "Missing data definition for Option");
      },
    );

    await t.step(
      "should throw error for duplicate match arm",
      () => {
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

        expect(() => {
          elaborateSystemF(match, syms);
        }).to.throw(
          CompilationError,
          "Duplicate match arm for constructor 'Some'",
        );
      },
    );

    await t.step(
      "should throw error when match is missing constructors",
      () => {
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

        expect(() => {
          elaborateSystemF(match, syms);
        }).to.throw(CompilationError, "match is missing constructors: None");
      },
    );

    await t.step(
      "should throw error when constructor parameter count doesn't match",
      () => {
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

        expect(() => {
          elaborateSystemF(match, syms);
        }).to.throw(
          CompilationError,
          "Constructor 'Some' expects 1 parameter(s)",
        );
      },
    );

    await t.step(
      "should throw error when constructor has too many parameters",
      () => {
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

        expect(() => {
          elaborateSystemF(match, syms);
        }).to.throw(
          CompilationError,
          "Constructor 'Some' expects 1 parameter(s)",
        );
      },
    );

    await t.step(
      "should throw error when match is missing multiple constructors",
      () => {
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

        expect(() => {
          elaborateSystemF(match, syms);
        }).to.throw(
          CompilationError,
          "match is missing constructors: Second, Third",
        );
      },
    );
  });
});
