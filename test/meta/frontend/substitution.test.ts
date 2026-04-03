import { test } from "node:test";
import { assert } from "../../util/assertions.ts";
import {
  alphaRenameTypeBinder,
  freeTermVars,
  freeTypeVars,
  substitute,
  substituteTypeHygienic,
} from "../../../lib/meta/frontend/substitution.ts";
import { CompilationError } from "../../../lib/meta/frontend/errors.ts";
import {
  mkSystemFAbs,
  mkSystemFTAbs,
  mkSystemFTypeApp,
  mkSystemFVar,
  type SystemFTerm,
} from "../../../lib/terms/systemF.ts";
import { mkSystemFApp } from "../../util/ast.ts";
import { mkTypeVariable, typeApp } from "../../../lib/types/types.ts";

test("substitute", async (t) => {
  await t.test("should throw on invalid type", () => {
    const type = { kind: "invalid" } as unknown;

    assert.throws(
      () =>
        substitute(
          type as SystemFTerm,
          () => [],
          () => false,
          (n) => n,
          () => true,
          (n, rebuilt) => {
            throw new CompilationError(
              "Substitution failed: no result found",
              "resolve",
              { term: n, substitutions: rebuilt },
            );
          },
        ),
      CompilationError,
      "Substitution failed: no result found",
    );
  });

  await t.test("should substitute a variable with a term", () => {
    const varTerm = mkSystemFVar("x");
    const replacement = mkSystemFVar("y");

    const result = substitute<SystemFTerm>(
      varTerm,
      () => [],
      (n) => n.kind === "systemF-var" && n.name === "x",
      () => replacement,
      () => false,
      (n) => n,
    );

    assert.deepEqual(result, replacement);
  });

  await t.test("should substitute within a term abstraction", () => {
    const absTerm = mkSystemFAbs(
      "x",
      { kind: "type-var", typeName: "T" },
      mkSystemFVar("x"),
    );
    const replacement = mkSystemFVar("y");

    const result = substitute<SystemFTerm>(
      absTerm,
      (n) => (n.kind === "systemF-abs" ? [n.body] : []),
      (n) => n.kind === "systemF-var" && n.name === "x",
      () => replacement,
      (n) => n.kind === "systemF-abs",
      (n, rebuilt) => {
        if (n.kind === "systemF-abs") {
          return mkSystemFAbs(n.name, n.typeAnnotation, rebuilt.pop()!);
        }
        return n;
      },
    );

    assert.deepEqual(
      result,
      mkSystemFAbs("x", { kind: "type-var", typeName: "T" }, replacement),
    );
  });

  await t.test("should substitute within a type abstraction", () => {
    const typeAbs = mkSystemFTAbs("X", mkSystemFVar("x"));
    const replacement = mkSystemFVar("y");

    const result = substitute<SystemFTerm>(
      typeAbs,
      (n) => (n.kind === "systemF-type-abs" ? [n.body] : []),
      (n) => n.kind === "systemF-var" && n.name === "x",
      () => replacement,
      (n) => n.kind === "systemF-type-abs",
      (n, rebuilt) => {
        if (n.kind === "systemF-type-abs") {
          return mkSystemFTAbs(n.typeVar, rebuilt.pop()!);
        }
        return n;
      },
    );

    assert.deepEqual(result, mkSystemFTAbs("X", replacement));
  });

  await t.test("should substitute within a type application", () => {
    const typeApp = mkSystemFTypeApp(mkSystemFVar("x"), {
      kind: "type-var",
      typeName: "T",
    });
    const replacement = mkSystemFVar("y");

    const result = substitute<SystemFTerm>(
      typeApp,
      (n) => (n.kind === "systemF-type-app" ? [n.term] : []),
      (n) => n.kind === "systemF-var" && n.name === "x",
      () => replacement,
      (n) => n.kind === "systemF-type-app",
      (n, rebuilt) => {
        if (n.kind === "systemF-type-app") {
          return mkSystemFTypeApp(rebuilt.pop()!, n.typeArg);
        }
        return n;
      },
    );

    assert.deepEqual(
      result,
      mkSystemFTypeApp(replacement, { kind: "type-var", typeName: "T" }),
    );
  });

  await t.test("should handle nested term substitution", () => {
    const nestedTerm = mkSystemFApp(
      mkSystemFAbs("x", { kind: "type-var", typeName: "T" }, mkSystemFVar("x")),
      mkSystemFVar("y"),
    );
    const replacement = mkSystemFVar("z");

    const result = substitute<SystemFTerm>(
      nestedTerm,
      (n) => {
        if (n.kind === "non-terminal") return [n.lft, n.rgt];
        if (n.kind === "systemF-abs") return [n.body];
        return [];
      },
      (n) => n.kind === "systemF-var" && n.name === "y",
      () => replacement,
      (n) => n.kind === "non-terminal" || n.kind === "systemF-abs",
      (n, rebuilt) => {
        if (n.kind === "non-terminal") {
          return mkSystemFApp(rebuilt.pop()!, rebuilt.pop()!);
        }
        if (n.kind === "systemF-abs") {
          return mkSystemFAbs(n.name, n.typeAnnotation, rebuilt.pop()!);
        }
        return n;
      },
    );

    const expected = mkSystemFApp(
      mkSystemFAbs("x", { kind: "type-var", typeName: "T" }, mkSystemFVar("x")),
      replacement,
    );

    assert.deepEqual(result, expected);
  });
});

test("substitution type-app helpers", async (t) => {
  await t.test("freeTermVars ignores type-app in annotations", () => {
    const listA = typeApp(mkTypeVariable("List"), mkTypeVariable("A"));
    const term = mkSystemFAbs("x", listA, mkSystemFVar("x"));
    const result = freeTermVars(term);
    assert.deepEqual(Array.from(result), []);
  });

  await t.test("freeTypeVars collects vars in type-app", () => {
    const listA = typeApp(mkTypeVariable("List"), mkTypeVariable("A"));
    const result = freeTypeVars(listA);
    assert.deepEqual(Array.from(result).sort(), ["A", "List"]);
  });

  await t.test("alphaRenameTypeBinder rewrites type-app", () => {
    const pairAB = typeApp(
      typeApp(mkTypeVariable("Pair"), mkTypeVariable("A")),
      mkTypeVariable("B"),
    );
    const result = alphaRenameTypeBinder(pairAB, "A", "X");
    assert.deepEqual(
      result,
      typeApp(
        typeApp(mkTypeVariable("Pair"), mkTypeVariable("X")),
        mkTypeVariable("B"),
      ),
    );
  });

  await t.test("substituteTypeHygienic replaces vars in type-app", () => {
    const listA = typeApp(mkTypeVariable("List"), mkTypeVariable("A"));
    const result = substituteTypeHygienic(listA, "A", mkTypeVariable("Nat"));
    assert.deepEqual(
      result,
      typeApp(mkTypeVariable("List"), mkTypeVariable("Nat")),
    );
  });
});
