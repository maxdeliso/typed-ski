import { test } from "node:test";
import { expect } from "../util/assertions.ts";
import { isRecursiveTypeDefinition } from "../../lib/linker/moduleLinker.ts";
import type { TripLangTerm } from "../../lib/meta/trip.ts";
import { mkUntypedAbs, mkVar } from "../../lib/terms/lambda.ts";

test("isRecursiveTypeDefinition", async (t) => {
  await t.test("returns false for non-type definitions", () => {
    // Arc 1: typeDef.kind !== "type"
    const lambdaDef: TripLangTerm = {
      kind: "lambda",
      name: "id",
      term: mkUntypedAbs("x", mkVar("x")),
    };

    expect(isRecursiveTypeDefinition(lambdaDef)).to.be.false;
  });

  await t.test("returns false when definition value extraction fails", () => {
    // Arc 2: extractDefinitionValue returns undefined (e.g., malformed type def)
    const malformedTypeDef = {
      kind: "type",
      name: "BadType",
      // Missing 'type' property makes extractDefinitionValue return undefined
    } as unknown as TripLangTerm;

    expect(isRecursiveTypeDefinition(malformedTypeDef)).to.be.false;
  });

  await t.test("returns false for non-recursive type definitions", () => {
    // Normal case: not recursive
    const typeDef: TripLangTerm = {
      kind: "type",
      name: "Nat",
      type: { kind: "type-var", typeName: "X" }, // References X, not Nat
    };

    expect(isRecursiveTypeDefinition(typeDef)).to.be.false;
  });

  await t.test("returns true for recursive type definitions", () => {
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

    expect(isRecursiveTypeDefinition(typeDef)).to.be.true;
  });
});
