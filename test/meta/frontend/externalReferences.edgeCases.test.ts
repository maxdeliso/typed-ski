import { assertEquals, assertStrictEquals } from "std/assert";

import { externalReferences } from "../../../lib/meta/frontend/externalReferences.ts";
import type { TripLangValueType } from "../../../lib/meta/trip.ts";
import { SKITerminalSymbol } from "../../../lib/ski/terminal.ts";
import { makeNatLiteralIdentifier } from "../../../lib/consts/natNames.ts";

Deno.test("externalReferences edge cases (coverage)", async (t) => {
  await t.step("ignores nat literal identifiers in systemF-var", () => {
    const lit = makeNatLiteralIdentifier(42n);
    const term: TripLangValueType = { kind: "systemF-var", name: lit };

    const [termRefs, typeRefs] = externalReferences(term);
    assertEquals(Array.from(termRefs.keys()), []);
    assertEquals(Array.from(typeRefs.keys()), []);
  });

  await t.step("tracks bindings correctly for systemF-let", () => {
    // let x = y in x  -> external refs: y only
    const term: TripLangValueType = {
      kind: "systemF-let",
      name: "x",
      value: { kind: "systemF-var", name: "y" },
      body: { kind: "systemF-var", name: "x" },
    };
    const [termRefs, typeRefs] = externalReferences(term);
    assertEquals(Array.from(termRefs.keys()).sort(), ["y"]);
    assertEquals(Array.from(typeRefs.keys()), []);
  });

  await t.step(
    "collects refs from typed-lambda-abstraction (ty + body)",
    () => {
      const term: TripLangValueType = {
        kind: "typed-lambda-abstraction",
        varName: "x",
        ty: { kind: "type-var", typeName: "A" },
        body: {
          kind: "non-terminal",
          lft: { kind: "lambda-var", name: "x" }, // bound
          rgt: { kind: "lambda-var", name: "f" }, // free
        },
      };

      const [termRefs, typeRefs] = externalReferences(term);
      assertEquals(Array.from(termRefs.keys()).sort(), ["f"]);
      assertEquals(Array.from(typeRefs.keys()).sort(), ["A"]);
    },
  );

  await t.step("collects refs inside BaseType type-app and forall", () => {
    const ty: TripLangValueType = {
      kind: "forall",
      typeVar: "A",
      body: {
        kind: "type-app",
        fn: { kind: "type-var", typeName: "List" },
        arg: { kind: "type-var", typeName: "A" }, // bound by forall
      },
    };

    const [_termRefs, typeRefs] = externalReferences(ty);
    assertEquals(Array.from(typeRefs.keys()).sort(), ["List"]);
  });

  await t.step("ignores SKI terminal nodes", () => {
    const ski: TripLangValueType = {
      kind: "terminal",
      sym: SKITerminalSymbol.S,
    };
    const [termRefs, typeRefs] = externalReferences(ski);
    assertEquals(Array.from(termRefs.keys()), []);
    assertEquals(Array.from(typeRefs.keys()), []);
  });

  await t.step(
    "memoizes results (same tuple identity on repeated calls)",
    () => {
      const term: TripLangValueType = {
        kind: "non-terminal",
        lft: { kind: "lambda-var", name: "x" },
        rgt: { kind: "lambda-var", name: "y" },
      };
      const r1 = externalReferences(term);
      const r2 = externalReferences(term);
      assertStrictEquals(r1, r2);
      // and the maps themselves should be referentially identical
      assertStrictEquals(r1[0], r2[0]);
      assertStrictEquals(r1[1], r2[1]);
    },
  );
});
