import { describe, it } from "../util/test_shim.ts";
import assert from "node:assert/strict";
import { isRecursiveTypeDefinition } from "../../lib/linker/moduleLinker.ts";
import type { TripLangTerm } from "../../lib/meta/trip.ts";
import { I } from "../../lib/ski/terminal.ts";

describe("isRecursiveTypeDefinition", () => {
  it("returns false for non-type definitions", () => {
    // Arc 1: typeDef.kind !== "type"
    const combinatorDef: TripLangTerm = {
      kind: "combinator",
      name: "id",
      term: I,
    };

    assert.strictEqual(isRecursiveTypeDefinition(combinatorDef), false);
  });

  it("returns false when definition value extraction fails", () => {
    // Arc 2: extractDefinitionValue returns undefined (e.g., malformed type def)
    const malformedTypeDef = {
      kind: "type",
      name: "BadType",
      // Missing 'type' property makes extractDefinitionValue return undefined
    } as unknown as TripLangTerm;

    assert.strictEqual(isRecursiveTypeDefinition(malformedTypeDef), false);
  });

  it("returns false for non-recursive type definitions", () => {
    // Normal case: not recursive
    const typeDef: TripLangTerm = {
      kind: "type",
      name: "Nat",
      type: { kind: "type-var", typeName: "X" }, // References X, not Nat
    };

    assert.strictEqual(isRecursiveTypeDefinition(typeDef), false);
  });

  it("returns true for recursive type definitions", () => {
    // Recursive case
    const typeDef: TripLangTerm = {
      kind: "type",
      name: "List",
      // List = ... List ...
      type: {
        kind: "non-terminal",
        lft: { kind: "type-var", typeName: "List" },
        rgt: { kind: "type-var", typeName: "X" },
      },
    };

    assert.strictEqual(isRecursiveTypeDefinition(typeDef), true);
  });
});
