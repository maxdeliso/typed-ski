import { assert } from "npm:chai";
import {
  extractDefinitionValue,
  indexSymbols,
  type PolyDefinition,
  type TripLangProgram,
  type TypedDefinition,
  type TypeDefinition,
} from "../../../lib/index.ts";
import { CompilationError } from "../../../lib/meta/frontend/compilation.ts";
import { searchAVL } from "../../../lib/data/avl/avlNode.ts";
import { compareStrings } from "../../../lib/data/map/stringMap.ts";

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
    const term = searchAVL(symbols.terms, "id", compareStrings);
    const type = searchAVL(symbols.types, "Nat", compareStrings);

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
