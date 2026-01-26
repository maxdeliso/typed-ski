import { expect } from "chai";
import { elaborateSystemF } from "../../../lib/meta/frontend/elaboration.ts";
import type { SymbolTable } from "../../../lib/meta/trip.ts";
import {
  mkSystemFAbs,
  mkSystemFApp,
  mkSystemFTAbs,
  mkSystemFTypeApp,
  mkSystemFVar,
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
});
