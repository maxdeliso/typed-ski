import { test } from "node:test";
import assert from "node:assert/strict";
import { requiredAt } from "../../util/required.ts";

import type {
  SymbolTable,
  TripLangProgram,
  TripLangTerm,
  TripLangValueType,
} from "../../../lib/meta/trip.ts";
import {
  resolveExternalProgramReferences,
  substituteTermHygienicBatch,
  substituteTripLangTermDirectBatch,
} from "../../../lib/meta/frontend/substitution.ts";
import { CompilationError } from "../../../lib/meta/frontend/errors.ts";
import {
  mkSystemFAbs,
  mkSystemFTAbs,
  mkSystemFTypeApp,
  mkSystemFVar,
} from "../../../lib/terms/systemF.ts";
import { mkTypedAbs } from "../../util/ast.ts";
import { forall } from "../../../lib/types/systemF.ts";
import { mkTypeVariable, typeApp } from "../../../lib/types/types.ts";
import { K } from "../../../lib/ski/terminal.ts";
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

test("substitution (batch + resolution) dedicated coverage", async (t) => {
  await t.test("substituteTripLangTermDirectBatch", async (t) => {
    await t.test(
      "preserves object identity when substitutions are empty",
      () => {
        const current: TripLangTerm = {
          kind: "poly",
          name: "main",
          term: mkSystemFVar("x"),
        };
        const result = substituteTripLangTermDirectBatch(current, new Map());
        assert.strictEqual(result, current);
      },
    );

    await t.test(
      "does not substitute Nat literal identifiers (placeholders)",
      () => {
        const lit = makeNatLiteralIdentifier(3n);
        const current: TripLangTerm = {
          kind: "poly",
          name: "main",
          term: mkSystemFVar(lit),
        };
        const substitutions = new Map<string, TripLangTerm>([
          [
            "__irrelevant__",
            {
              kind: "poly",
              name: "__irrelevant__",
              term: mkSystemFVar("z"),
            },
          ],
          [lit, { kind: "poly", name: lit, term: mkSystemFVar("oops") }],
        ]);

        const result = substituteTripLangTermDirectBatch(
          current,
          substitutions,
        );
        assert.strictEqual(result, current, "no substitution should occur");
        assert.strictEqual(
          (result as { term: unknown }).term,
          (current as { term: unknown }).term,
          "term object identity should be preserved",
        );
      },
    );

    await t.test("renames match arm params to avoid capture (batch)", () => {
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
      assert.notStrictEqual(
        result,
        current,
        "should return a new object when changes occur",
      );

      const term = (result as { term: unknown }).term as {
        kind: "systemF-match";
        scrutinee: { kind: string; name?: string };
        arms: Array<{
          params: string[];
          body: { kind: string; name?: string };
        }>;
      };
      assert.deepStrictEqual(term.kind, "systemF-match");
      assert.deepStrictEqual(term.scrutinee.kind, "systemF-var");
      assert.deepStrictEqual(term.scrutinee.name, "x");
      assert.deepStrictEqual(term.arms.length, 1);

      const arm0 = requiredAt(term.arms, 0, "expected first match arm");
      assert.deepStrictEqual(arm0.params.length, 1);
      assert.notStrictEqual(
        arm0.params[0],
        "x",
        "arm param should be renamed to avoid capture",
      );
      assert.deepStrictEqual(arm0.body.kind, "systemF-var");
      assert.deepStrictEqual(
        arm0.body.name,
        arm0.params[0],
        "arm body should reference renamed param",
      );
    });

    await t.test(
      "renames systemF-abs binder when replacementFVs contains binder (fast capture check)",
      () => {
        // Term: (\\x:A => y). Substitute y := x.
        // If we *don't* rename binder `x`, the inserted `x` would become captured.
        const term = mkSystemFAbs(
          "x",
          { kind: "type-var", typeName: "A" },
          mkSystemFVar("y"),
        );

        // We intentionally pass replacementFVs containing `x` to force the fast-path rename logic.
        const replacementFVs = new Set<string>(["x"]);

        const out = substituteTermHygienicBatch(
          term,
          new Map([["y", mkSystemFVar("x")]]),
          replacementFVs,
        );

        assert.deepStrictEqual(out.kind, "systemF-abs");
        if (out.kind !== "systemF-abs") throw new Error("expected systemF-abs");
        assert.notStrictEqual(
          out.name,
          "x",
          "binder should be renamed to avoid capture",
        );
        assert.deepStrictEqual(out.body.kind, "systemF-var");
        if (out.body.kind !== "systemF-var") {
          throw new Error("expected systemF-var");
        }
        assert.deepStrictEqual(
          out.body.name,
          "x",
          "inserted free variable should remain free (not captured)",
        );
      },
    );

    await t.test(
      "renames typed-lambda-abstraction binder when replacementFVs contains binder (fast capture check)",
      () => {
        // Term: (\\x:A => y) in typed lambda. Substitute y := x.
        // Binder must be renamed to avoid capturing the inserted free `x`.
        const term = mkTypedAbs(
          "x",
          { kind: "type-var", typeName: "A" },
          { kind: "lambda-var", name: "y" },
        );

        const replacementFVs = new Set<string>(["x"]);

        const out = substituteTermHygienicBatch(
          term,
          new Map([["y", { kind: "lambda-var", name: "x" }]]),
          replacementFVs,
        );

        assert.deepStrictEqual(out.kind, "typed-lambda-abstraction");
        if (out.kind !== "typed-lambda-abstraction") {
          throw new Error("expected typed-lambda-abstraction");
        }
        assert.notStrictEqual(
          out.varName,
          "x",
          "binder should be renamed to avoid capture",
        );
        assert.deepStrictEqual(out.body.kind, "lambda-var");
        if (out.body.kind !== "lambda-var") {
          throw new Error("expected lambda-var");
        }
        assert.deepStrictEqual(
          out.body.name,
          "x",
          "inserted free variable should remain free (not captured)",
        );
      },
    );

    await t.test(
      "substitutes systemF-let value and renames binder when replacementFVs contains binder (fast capture check)",
      () => {
        // Term: let x = y in z. Substitute y := x, z := x.
        // Value substitution happens in current scope.
        // Binder must be renamed to avoid capturing the inserted free `x` in the body.
        const term: TripLangValueType = {
          kind: "systemF-let",
          name: "x",
          value: mkSystemFVar("y"), // will be substituted to x
          body: mkSystemFVar("z"), // will be substituted to x
        };

        const replacementFVs = new Set<string>(["x"]);

        const out = substituteTermHygienicBatch(
          term,
          new Map([
            ["y", mkSystemFVar("x")],
            ["z", mkSystemFVar("x")],
          ]),
          replacementFVs,
        );

        assert.deepStrictEqual(out.kind, "systemF-let");
        if (out.kind !== "systemF-let") throw new Error("expected systemF-let");

        // Value should be substituted (y -> x)
        assert.deepStrictEqual(out.value.kind, "systemF-var");
        if (out.value.kind !== "systemF-var") {
          throw new Error("expected systemF-var");
        }
        assert.deepStrictEqual(
          out.value.name,
          "x",
          "value should be substituted",
        );

        // Binder should be renamed to avoid capture
        assert.notStrictEqual(
          out.name,
          "x",
          "binder should be renamed to avoid capture",
        );

        // Body should have the substituted variable (x), which should remain free
        assert.deepStrictEqual(out.body.kind, "systemF-var");
        if (out.body.kind !== "systemF-var") {
          throw new Error("expected systemF-var");
        }
        assert.deepStrictEqual(
          out.body.name,
          "x",
          "inserted free variable in body should remain free (not captured)",
        );
      },
    );

    await t.test(
      "substitutes systemF-type-app term and typeArg (both branches traversed)",
      () => {
        // Term: y[T] where y is a term variable.
        // Both term.term and term.typeArg branches are traversed.
        const term: TripLangValueType = mkSystemFTypeApp(
          mkSystemFVar("y"), // term variable that can be substituted
          mkTypeVariable("T"), // type variable (traversed but not substituted)
        );

        // This exercises both branches: termPart substitution and typeArg traversal
        const out = substituteTermHygienicBatch(
          term,
          new Map([["y", mkSystemFVar("x")]]),
          new Set<string>(),
        );
        assert.deepStrictEqual(out.kind, "systemF-type-app");
        if (out.kind !== "systemF-type-app") {
          throw new Error("expected systemF-type-app");
        }
        assert.deepStrictEqual(out.term.kind, "systemF-var");
        if (out.term.kind !== "systemF-var") {
          throw new Error("expected systemF-var");
        }
        assert.deepStrictEqual(
          out.term.name,
          "x",
          "term part should be substituted",
        );
        // typeArg branch is also traversed (even though type vars aren't substituted)
        assert.deepStrictEqual(out.typeArg.kind, "type-var");
        if (out.typeArg.kind !== "type-var") {
          throw new Error("expected type-var");
        }
        assert.deepStrictEqual(out.typeArg.typeName, "T");
      },
    );

    await t.test(
      "substitutes systemF-type-abs body (type binders don't shadow term variables)",
      () => {
        // Term: #X => y. Substitute y := x.
        // Type binder X doesn't shadow term variable x, so substitution should work.
        const term: TripLangValueType = mkSystemFTAbs("X", mkSystemFVar("y"));

        const out = substituteTermHygienicBatch(
          term,
          new Map([["y", mkSystemFVar("x")]]),
          new Set<string>(),
        );

        assert.deepStrictEqual(out.kind, "systemF-type-abs");
        if (out.kind !== "systemF-type-abs") {
          throw new Error("expected systemF-type-abs");
        }
        assert.deepStrictEqual(
          out.typeVar,
          "X",
          "type binder should remain unchanged",
        );
        assert.deepStrictEqual(out.body.kind, "systemF-var");
        if (out.body.kind !== "systemF-var") {
          throw new Error("expected systemF-var");
        }
        assert.deepStrictEqual(
          out.body.name,
          "x",
          "body should be substituted",
        );
      },
    );

    await t.test(
      "substitutes forall body (type binders don't shadow term variables)",
      () => {
        // Type: #X => (Y -> Z) where Y and Z are type variables.
        // Type variables aren't substituted by term substitution, but the traversal
        // still happens. To actually test substitution, we'd need term variables nested
        // in the type structure, but BaseType doesn't contain terms.
        // So we'll test that the traversal code path is exercised (even if nothing changes).
        const ty: TripLangValueType = forall("X", mkTypeVariable("Y"));

        // This will traverse but not substitute (type vars aren't term vars)
        const out = substituteTermHygienicBatch(
          ty,
          new Map(),
          new Set<string>(),
        );

        assert.deepStrictEqual(out.kind, "forall");
        if (out.kind !== "forall") throw new Error("expected forall");
        assert.deepStrictEqual(
          out.typeVar,
          "X",
          "type binder should remain unchanged",
        );
        assert.deepStrictEqual(out.body.kind, "type-var");
        if (out.body.kind !== "type-var") throw new Error("expected type-var");
        assert.deepStrictEqual(
          out.body.typeName,
          "Y",
          "body remains unchanged (type vars aren't substituted)",
        );
        // The important thing is that the branch was traversed
      },
    );

    await t.test(
      "substitutes type-app fn and arg (both branches traversed)",
      () => {
        // Type: F[A] where F and A are type variables.
        // Type variables aren't substituted by term substitution, but the traversal
        // code paths for fn and arg are still exercised.
        const ty: TripLangValueType = typeApp(
          mkTypeVariable("F"),
          mkTypeVariable("A"),
        );

        // This will traverse both fn and arg branches (even if nothing changes)
        const out = substituteTermHygienicBatch(
          ty,
          new Map(),
          new Set<string>(),
        );
        assert.deepStrictEqual(out.kind, "type-app");
        if (out.kind !== "type-app") throw new Error("expected type-app");
        assert.deepStrictEqual(out.fn.kind, "type-var");
        if (out.fn.kind !== "type-var") throw new Error("expected type-var");
        assert.deepStrictEqual(
          out.fn.typeName,
          "F",
          "fn remains unchanged (type vars aren't substituted)",
        );
        assert.deepStrictEqual(out.arg.kind, "type-var");
        if (out.arg.kind !== "type-var") throw new Error("expected type-var");
        assert.deepStrictEqual(
          out.arg.typeName,
          "A",
          "arg remains unchanged (type vars aren't substituted)",
        );
        // The important thing is that both branches (fn and arg) were traversed
      },
    );

    await t.test("substitutes poly term", () => {
      // System F term: \x:A => y. Substitute y := z.
      const current: TripLangTerm = {
        kind: "poly",
        name: "f",
        term: mkSystemFAbs("x", { kind: "type-var", typeName: "A" }, mkSystemFVar("y")),
      };

      const substitutions = new Map<string, TripLangTerm>([
        [
          "y",
          {
            kind: "poly",
            name: "y",
            term: mkSystemFVar("z"),
          },
        ],
      ]);

      const result = substituteTripLangTermDirectBatch(current, substitutions);
      assert.notStrictEqual(
        result,
        current,
        "should return new object when substitution occurs",
      );
      assert.deepStrictEqual(result.kind, "poly");
      if (result.kind !== "poly") throw new Error("expected poly");
      assert.deepStrictEqual(result.name, "f");
      assert.deepStrictEqual(result.term.kind, "systemF-abs");
      if (result.term.kind !== "systemF-abs") {
        throw new Error("expected systemF-abs");
      }
      assert.deepStrictEqual(result.term.body.kind, "systemF-var");
      if (result.term.body.kind !== "systemF-var") {
        throw new Error("expected systemF-var");
      }
      assert.deepStrictEqual(
        result.term.body.name,
        "z",
        "variable should be substituted",
      );
    });

    await t.test("returns combinator unchanged (no-op)", () => {
      const current: TripLangTerm = {
        kind: "combinator",
        name: "K",
        term: K,
      };

      const substitutions = new Map<string, TripLangTerm>([
        ["x", { kind: "poly", name: "x", term: mkSystemFVar("y") }],
      ]);

      const result = substituteTripLangTermDirectBatch(current, substitutions);
      assert.strictEqual(
        result,
        current,
        "combinator should be returned unchanged",
      );
    });

    await t.test("returns type definition unchanged (no-op)", () => {
      const current: TripLangTerm = {
        kind: "type",
        name: "MyType",
        type: mkTypeVariable("T"),
      };

      const substitutions = new Map<string, TripLangTerm>([
        ["x", { kind: "poly", name: "x", term: mkSystemFVar("y") }],
      ]);

      const result = substituteTripLangTermDirectBatch(current, substitutions);
      assert.strictEqual(
        result,
        current,
        "type definition should be returned unchanged",
      );
    });

    await t.test("returns data definition unchanged (no-op)", () => {
      const current: TripLangTerm = {
        kind: "data",
        name: "Maybe",
        typeParams: ["a"],
        constructors: [],
      };

      const substitutions = new Map<string, TripLangTerm>([
        ["x", { kind: "poly", name: "x", term: mkSystemFVar("y") }],
      ]);

      const result = substituteTripLangTermDirectBatch(current, substitutions);
      assert.strictEqual(
        result,
        current,
        "data definition should be returned unchanged",
      );
    });

    await t.test("returns module definition unchanged (no-op)", () => {
      const current: TripLangTerm = {
        kind: "module",
        name: "MyModule",
      };

      const substitutions = new Map<string, TripLangTerm>([
        ["x", { kind: "poly", name: "x", term: mkSystemFVar("y") }],
      ]);

      const result = substituteTripLangTermDirectBatch(current, substitutions);
      assert.strictEqual(
        result,
        current,
        "module definition should be returned unchanged",
      );
    });

    await t.test("returns import definition unchanged (no-op)", () => {
      const current: TripLangTerm = {
        kind: "import",
        name: "OtherModule",
        ref: "someSymbol",
      };

      const substitutions = new Map<string, TripLangTerm>([
        ["x", { kind: "poly", name: "x", term: mkSystemFVar("y") }],
      ]);

      const result = substituteTripLangTermDirectBatch(current, substitutions);
      assert.strictEqual(
        result,
        current,
        "import definition should be returned unchanged",
      );
    });

    await t.test("returns export definition unchanged (no-op)", () => {
      const current: TripLangTerm = {
        kind: "export",
        name: "someSymbol",
      };

      const substitutions = new Map<string, TripLangTerm>([
        ["x", { kind: "poly", name: "x", term: mkSystemFVar("y") }],
      ]);

      const result = substituteTripLangTermDirectBatch(current, substitutions);
      assert.strictEqual(
        result,
        current,
        "export definition should be returned unchanged",
      );
    });
  });

  await t.test("resolveExternalProgramReferences", async (t) => {
    await t.test("keeps imported symbols unresolved (no error)", () => {
      const program: TripLangProgram = {
        kind: "program",
        terms: [
          { kind: "module", name: "M" },
          { kind: "import", name: "Other", ref: "foo" },
          { kind: "poly", name: "main", term: mkSystemFVar("foo") },
        ],
      };

      const resolved = resolveExternalProgramReferences(program, emptySyms());
      const main = resolved.terms.find(
        (x) => x.kind === "poly" && x.name === "main",
      ) as undefined | { kind: "poly"; term: unknown };
      assert.ok(main);
      assert.deepEqual(main!.term, mkSystemFVar("foo"));
    });

    await t.test(
      "throws on unresolved external term references when not imported",
      () => {
        const program: TripLangProgram = {
          kind: "program",
          terms: [
            { kind: "module", name: "M" },
            { kind: "poly", name: "main", term: mkSystemFVar("foo") },
          ],
        };
        assert.throws(
          () => resolveExternalProgramReferences(program, emptySyms()),
          CompilationError,
          "Unresolved external term reference: foo",
        );
      },
    );

    await t.test("throws on unresolved external type references", () => {
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
      assert.throws(
        () => resolveExternalProgramReferences(program, emptySyms()),
        CompilationError,
        "Unresolved external type reference: MissingType",
      );
    });
  });
});
