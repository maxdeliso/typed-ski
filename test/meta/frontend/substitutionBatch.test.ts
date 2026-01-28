import { assert } from "chai";
import { assertEquals, assertNotEquals, assertStrictEquals, assertThrows } from "std/assert";

import type { SymbolTable, TripLangProgram, TripLangTerm } from "../../../lib/meta/trip.ts";
import {
  resolveExternalProgramReferences,
  substituteTripLangTermDirectBatch,
} from "../../../lib/meta/frontend/substitution.ts";
import { CompilationError } from "../../../lib/meta/frontend/compilation.ts";
import {
  mkSystemFAbs,
  mkSystemFVar,
} from "../../../lib/terms/systemF.ts";
import { makeNatLiteralIdentifier } from "../../../lib/consts/natNames.ts";

function emptySyms(): SymbolTable {
  return {
    terms: new Map(),
    types: new Map(),
    data: new Map(),
    constructors: new Map(),
    imports: new Set(),
  };
}

Deno.test("substitution (batch + resolution) dedicated coverage", async (t) => {
  await t.step("substituteTripLangTermDirectBatch", async (t) => {
    await t.step("preserves object identity when substitutions are empty", () => {
      const current: TripLangTerm = {
        kind: "poly",
        name: "main",
        term: mkSystemFVar("x"),
      };
      const result = substituteTripLangTermDirectBatch(current, new Map());
      assertStrictEquals(result, current);
    });

    await t.step("does not substitute Nat literal identifiers (placeholders)", () => {
      const lit = makeNatLiteralIdentifier(3n);
      const current: TripLangTerm = {
        kind: "poly",
        name: "main",
        term: mkSystemFVar(lit),
      };
      const substitutions = new Map<string, TripLangTerm>([
        ["__irrelevant__", { kind: "poly", name: "__irrelevant__", term: mkSystemFVar("z") }],
        [lit, { kind: "poly", name: lit, term: mkSystemFVar("oops") }],
      ]);

      const result = substituteTripLangTermDirectBatch(current, substitutions);
      assertStrictEquals(result, current, "no substitution should occur");
      assertStrictEquals(
        (result as { term: unknown }).term,
        (current as { term: unknown }).term,
        "term object identity should be preserved",
      );
    });

    await t.step("renames match arm params to avoid capture (batch)", () => {
      const current: TripLangTerm = {
        kind: "poly",
        name: "main",
        term: {
          kind: "systemF-match",
          scrutinee: mkSystemFVar("m"),
          returnType: { kind: "type-var", typeName: "T" },
          arms: [
            {
              constructorName: "Some",
              params: ["x"],
              body: mkSystemFVar("x"),
            },
          ],
        },
      };

      // Replace `m` with free variable `x` (which would be captured by the match arm param `x`)
      const substitutions = new Map<string, TripLangTerm>([
        ["m", { kind: "poly", name: "m", term: mkSystemFVar("x") }],
      ]);

      const result = substituteTripLangTermDirectBatch(current, substitutions);
      assertNotEquals(result, current, "should return a new object when changes occur");

      const term = (result as { term: unknown }).term as {
        kind: "systemF-match";
        scrutinee: { kind: string; name?: string };
        arms: Array<{ params: string[]; body: { kind: string; name?: string } }>;
      };
      assertEquals(term.kind, "systemF-match");
      assertEquals(term.scrutinee.kind, "systemF-var");
      assertEquals(term.scrutinee.name, "x");
      assertEquals(term.arms.length, 1);

      const arm0 = term.arms[0];
      assertEquals(arm0.params.length, 1);
      assertNotEquals(arm0.params[0], "x", "arm param should be renamed to avoid capture");
      assertEquals(arm0.body.kind, "systemF-var");
      assertEquals(arm0.body.name, arm0.params[0], "arm body should reference renamed param");
    });
  });

  await t.step("resolveExternalProgramReferences", async (t) => {
    await t.step("keeps imported symbols unresolved (no error)", () => {
      const program: TripLangProgram = {
        kind: "program",
        terms: [
          { kind: "module", name: "M" },
          { kind: "import", name: "Other", ref: "foo" },
          { kind: "poly", name: "main", term: mkSystemFVar("foo") },
        ],
      };

      const resolved = resolveExternalProgramReferences(program, emptySyms());
      const main = resolved.terms.find((x) => x.kind === "poly" && x.name === "main") as
        | undefined
        | { kind: "poly"; term: unknown };
      assert.isDefined(main);
      assert.deepEqual(main!.term, mkSystemFVar("foo"));
    });

    await t.step("throws on unresolved external term references when not imported", () => {
      const program: TripLangProgram = {
        kind: "program",
        terms: [
          { kind: "module", name: "M" },
          { kind: "poly", name: "main", term: mkSystemFVar("foo") },
        ],
      };
      assertThrows(
        () => resolveExternalProgramReferences(program, emptySyms()),
        CompilationError,
        "Unresolved external term reference: foo",
      );
    });

    await t.step("throws on unresolved external type references", () => {
      // System F abstraction with a type annotation that references an unknown type var name.
      // Note: externalReferences treats type vars as references for resolution.
      const program: TripLangProgram = {
        kind: "program",
        terms: [
          { kind: "module", name: "M" },
          {
            kind: "poly",
            name: "main",
            term: mkSystemFAbs(
              "x",
              { kind: "type-var", typeName: "MissingType" },
              mkSystemFVar("x"),
            ),
          },
        ],
      };
      assertThrows(
        () => resolveExternalProgramReferences(program, emptySyms()),
        CompilationError,
        "Unresolved external type reference: MissingType",
      );
    });
  });
});

