import { describe, it } from "../../util/test_shim.ts";
/**
 * Tests for hygienic substitution functions
 *
 * This module tests the hygienic substitution algorithms that avoid variable
 * capture by tracking bound variables and performing alpha-renaming when necessary.
 */

import assert from "node:assert/strict";
import { requiredAt } from "../../util/required.ts";
import {
  alphaRenameTermBinder,
  alphaRenameTypeBinder,
  freeTermVars,
  freeTypeVars,
  fresh,
  substituteHygienic,
  substituteTypeHygienic,
} from "../../../lib/meta/frontend/substitution.ts";
import type { TripLangValueType } from "../../../lib/meta/trip.ts";
import { SKITerminalSymbol } from "../../../lib/ski/terminal.ts";

describe("hygienic substitution functions", () => {
  describe("freeTermVars", () => {
    it("should identify free variables in lambda abstraction", () => {
      const term: TripLangValueType = {
        kind: "lambda-abs",
        name: "x",
        body: {
          kind: "lambda-var",
          name: "y",
        },
      };
      const free = freeTermVars(term);
      assert.deepStrictEqual(free.size, 1);
      assert.deepStrictEqual(free.has("y"), true);
      assert.deepStrictEqual(free.has("x"), false);
    });

    it("should identify free variables in System F abstraction", () => {
      const term: TripLangValueType = {
        kind: "systemF-abs",
        name: "x",
        typeAnnotation: {
          kind: "type-var",
          typeName: "A",
        },
        body: {
          kind: "systemF-var",
          name: "y",
        },
      };
      const free = freeTermVars(term);
      assert.deepStrictEqual(free.size, 1);
      assert.deepStrictEqual(free.has("y"), true);
      assert.deepStrictEqual(free.has("x"), false);
    });

    it("should identify free variables in nested abstractions", () => {
      const term: TripLangValueType = {
        kind: "lambda-abs",
        name: "x",
        body: {
          kind: "lambda-abs",
          name: "y",
          body: {
            kind: "lambda-var",
            name: "z",
          },
        },
      };
      const free = freeTermVars(term);
      assert.deepStrictEqual(free.size, 1);
      assert.deepStrictEqual(free.has("z"), true);
      assert.deepStrictEqual(free.has("x"), false);
      assert.deepStrictEqual(free.has("y"), false);
    });

    it("should identify free variables in type abstractions", () => {
      const term: TripLangValueType = {
        kind: "systemF-type-abs",
        typeVar: "A",
        body: {
          kind: "systemF-var",
          name: "x",
        },
      };
      const free = freeTermVars(term);
      assert.deepStrictEqual(free.size, 1);
      assert.deepStrictEqual(free.has("x"), true);
    });

    it("should identify free variables in applications", () => {
      const term: TripLangValueType = {
        kind: "non-terminal",
        lft: {
          kind: "lambda-var",
          name: "f",
        },
        rgt: {
          kind: "lambda-var",
          name: "x",
        },
      };
      const free = freeTermVars(term);
      assert.deepStrictEqual(free.size, 2);
      assert.deepStrictEqual(free.has("f"), true);
      assert.deepStrictEqual(free.has("x"), true);
    });

    it("should identify free variables in match expression", () => {
      const term: TripLangValueType = {
        kind: "systemF-match",
        scrutinee: {
          kind: "systemF-var",
          name: "x",
        },
        returnType: {
          kind: "type-var",
          typeName: "T",
        },
        arms: [
          {
            constructorName: "Some",
            params: ["a"],
            body: {
              kind: "systemF-var",
              name: "y",
            },
          },
          {
            constructorName: "None",
            params: [],
            body: {
              kind: "systemF-var",
              name: "z",
            },
          },
        ],
      };
      const free = freeTermVars(term);
      assert.deepStrictEqual(free.size, 3);
      assert.deepStrictEqual(free.has("x"), true);
      assert.deepStrictEqual(free.has("y"), true);
      assert.deepStrictEqual(free.has("z"), true);
      assert.deepStrictEqual(free.has("a"), false); // Bound in match arm
    });

    it("should not count match arm parameters as free variables", () => {
      const term: TripLangValueType = {
        kind: "systemF-match",
        scrutinee: {
          kind: "systemF-var",
          name: "m",
        },
        returnType: {
          kind: "type-var",
          typeName: "T",
        },
        arms: [
          {
            constructorName: "Cons",
            params: ["a", "b"],
            body: {
              kind: "systemF-var",
              name: "a", // Bound by match arm parameter
            },
          },
        ],
      };
      const free = freeTermVars(term);
      assert.deepStrictEqual(free.size, 1);
      assert.deepStrictEqual(free.has("m"), true);
      assert.deepStrictEqual(free.has("a"), false);
      assert.deepStrictEqual(free.has("b"), false);
    });

    it("should identify free variables in systemF-let", () => {
      const term: TripLangValueType = {
        kind: "systemF-let",
        name: "x",
        value: { kind: "systemF-var", name: "y" },
        body: { kind: "systemF-var", name: "z" },
      };
      const free = freeTermVars(term);
      assert.deepStrictEqual(free.size, 2);
      assert.deepStrictEqual(free.has("y"), true);
      assert.deepStrictEqual(free.has("z"), true);
      assert.deepStrictEqual(free.has("x"), false);
    });

    it("should not count systemF-let binder as free in body", () => {
      const term: TripLangValueType = {
        kind: "systemF-let",
        name: "x",
        value: { kind: "systemF-var", name: "y" },
        body: { kind: "systemF-var", name: "x" },
      };
      const free = freeTermVars(term);
      assert.deepStrictEqual(free.size, 1);
      assert.deepStrictEqual(free.has("y"), true);
      assert.deepStrictEqual(free.has("x"), false);
    });
  });

  describe("freeTypeVars", () => {
    it("should identify free type variables", () => {
      const term: TripLangValueType = {
        kind: "systemF-type-abs",
        typeVar: "A",
        body: {
          kind: "systemF-var",
          name: "x",
        },
      };
      const free = freeTypeVars(term);
      assert.deepStrictEqual(free.size, 0);
      assert.deepStrictEqual(free.has("x"), false);
      assert.deepStrictEqual(free.has("A"), false);
    });

    it("should identify free type variables in nested abstractions", () => {
      const term: TripLangValueType = {
        kind: "systemF-type-abs",
        typeVar: "A",
        body: {
          kind: "systemF-type-abs",
          typeVar: "B",
          body: {
            kind: "systemF-var",
            name: "x",
          },
        },
      };
      const free = freeTypeVars(term);
      assert.deepStrictEqual(free.size, 0);
      assert.deepStrictEqual(free.has("x"), false);
      assert.deepStrictEqual(free.has("A"), false);
      assert.deepStrictEqual(free.has("B"), false);
    });

    it("should identify free type variables in match expression", () => {
      const term: TripLangValueType = {
        kind: "systemF-match",
        scrutinee: {
          kind: "systemF-var",
          name: "x",
        },
        returnType: {
          kind: "type-var",
          typeName: "T",
        },
        arms: [
          {
            constructorName: "Some",
            params: ["a"],
            body: {
              kind: "systemF-var",
              name: "y",
            },
          },
        ],
      };
      const free = freeTypeVars(term);
      assert.deepStrictEqual(free.size, 1);
      assert.deepStrictEqual(free.has("T"), true);
    });

    it("should identify free type variables in systemF-let", () => {
      const term: TripLangValueType = {
        kind: "systemF-let",
        name: "x",
        value: {
          kind: "systemF-type-app",
          term: { kind: "systemF-var", name: "f" },
          typeArg: { kind: "type-var", typeName: "A" },
        },
        body: { kind: "systemF-var", name: "x" },
      };
      const free = freeTypeVars(term);
      assert.deepStrictEqual(free.size, 1);
      assert.deepStrictEqual(free.has("A"), true);
    });
  });

  describe("fresh", () => {
    it("should generate a fresh variable name", () => {
      const forbidden = new Set(["x", "y", "z"]);
      const name = fresh("x", forbidden);
      assert.deepStrictEqual(forbidden.has(name), false);
      assert.deepStrictEqual(name.startsWith("x"), true);
    });

    it("should handle empty forbidden set", () => {
      const name = fresh("x", new Set());
      assert.deepStrictEqual(name, "x");
    });

    it("should handle multiple collisions", () => {
      const forbidden = new Set(["x", "x_0", "x_1"]);
      const name = fresh("x", forbidden);
      assert.deepStrictEqual(name, "x_2");
    });
  });

  describe("alphaRenameTermBinder", () => {
    it("should rename lambda binder", () => {
      const term: TripLangValueType = {
        kind: "lambda-abs",
        name: "x",
        body: {
          kind: "lambda-var",
          name: "x",
        },
      };
      const renamed = alphaRenameTermBinder(term, "x", "y");
      assert.deepStrictEqual(renamed.kind, "lambda-abs");
      assert.deepStrictEqual((renamed as { name: string }).name, "y");
      assert.deepStrictEqual(
        (renamed as { body: { name: string } }).body.name,
        "y",
      );
    });

    it("should rename System F term binder", () => {
      const term: TripLangValueType = {
        kind: "systemF-abs",
        name: "x",
        typeAnnotation: {
          kind: "type-var",
          typeName: "A",
        },
        body: {
          kind: "systemF-var",
          name: "x",
        },
      };
      const renamed = alphaRenameTermBinder(term, "x", "y");
      assert.deepStrictEqual(renamed.kind, "systemF-abs");
      assert.deepStrictEqual((renamed as { name: string }).name, "y");
      assert.deepStrictEqual(
        (renamed as { body: { name: string } }).body.name,
        "y",
      );
    });

    it("should not rename if binder name doesn't match", () => {
      const term: TripLangValueType = {
        kind: "lambda-abs",
        name: "x",
        body: {
          kind: "lambda-var",
          name: "x",
        },
      };
      const renamed = alphaRenameTermBinder(term, "z", "y");
      assert.deepStrictEqual(renamed.kind, "lambda-abs");
      assert.deepStrictEqual((renamed as { name: string }).name, "x");
      assert.deepStrictEqual(
        (renamed as { body: { name: string } }).body.name,
        "x",
      );
    });

    it("should rename systemF-let binder", () => {
      const term: TripLangValueType = {
        kind: "systemF-let",
        name: "x",
        value: { kind: "systemF-var", name: "y" },
        body: { kind: "systemF-var", name: "x" },
      };
      const renamed = alphaRenameTermBinder(term, "x", "z");
      assert.deepStrictEqual(renamed.kind, "systemF-let");
      assert.deepStrictEqual((renamed as { name: string }).name, "z");
      assert.deepStrictEqual(
        (renamed as { value: { name: string } }).value.name,
        "y",
      );
      assert.deepStrictEqual(
        (renamed as { body: { name: string } }).body.name,
        "z",
      );
    });
  });

  describe("alphaRenameTypeBinder", () => {
    it("should rename forall binder", () => {
      const term: TripLangValueType = {
        kind: "forall",
        typeVar: "A",
        body: {
          kind: "type-var",
          typeName: "A",
        },
      };
      const renamed = alphaRenameTypeBinder(term, "A", "B");
      assert.deepStrictEqual(renamed.kind, "forall");
      assert.deepStrictEqual((renamed as { typeVar: string }).typeVar, "B");
      assert.deepStrictEqual(
        (renamed as { body: { typeName: string } }).body.typeName,
        "B",
      );
    });

    it("should rename System F type binder", () => {
      const term: TripLangValueType = {
        kind: "systemF-type-abs",
        typeVar: "A",
        body: {
          kind: "systemF-var",
          name: "x",
        },
      };
      const renamed = alphaRenameTypeBinder(term, "A", "B");
      assert.deepStrictEqual(renamed.kind, "systemF-type-abs");
      assert.deepStrictEqual((renamed as { typeVar: string }).typeVar, "B");
      // The body should remain unchanged since it doesn't contain the type variable
      assert.deepStrictEqual(
        (renamed as { body: { name: string } }).body.name,
        "x",
      );
    });

    it("should not rename if binder name doesn't match", () => {
      const term: TripLangValueType = {
        kind: "forall",
        typeVar: "A",
        body: {
          kind: "type-var",
          typeName: "A",
        },
      };
      const renamed = alphaRenameTypeBinder(term, "B", "C");
      assert.deepStrictEqual(renamed.kind, "forall");
      assert.deepStrictEqual((renamed as { typeVar: string }).typeVar, "A");
      assert.deepStrictEqual(
        (renamed as { body: { typeName: string } }).body.typeName,
        "A",
      );
    });

    it("should rename type variables in match expression", () => {
      const term: TripLangValueType = {
        kind: "systemF-match",
        scrutinee: {
          kind: "systemF-var",
          name: "x",
        },
        returnType: {
          kind: "type-var",
          typeName: "A",
        },
        arms: [
          {
            constructorName: "Some",
            params: ["a"],
            body: {
              kind: "systemF-var",
              name: "a",
            },
          },
        ],
      };
      const renamed = alphaRenameTypeBinder(term, "A", "B");
      assert.deepStrictEqual(renamed.kind, "systemF-match");
      assert.deepStrictEqual(
        (renamed as { returnType: { typeName: string } }).returnType.typeName,
        "B",
      );
      // Scrutinee and arms should remain unchanged
      assert.deepStrictEqual(
        (renamed as { scrutinee: { name: string } }).scrutinee.name,
        "x",
      );
      const arm = requiredAt(
        (
          renamed as {
            arms: Array<{ params: string[]; body: { name: string } }>;
          }
        ).arms,
        0,
        "expected first match arm",
      );
      assert.deepStrictEqual(
        requiredAt(arm.params, 0, "expected first arm parameter"),
        "a",
      );
      assert.deepStrictEqual(arm.body.name, "a");
    });

    it("should rename type variables in match scrutinee and return type", () => {
      const term: TripLangValueType = {
        kind: "systemF-match",
        scrutinee: {
          kind: "systemF-type-app",
          term: {
            kind: "systemF-var",
            name: "x",
          },
          typeArg: {
            kind: "type-var",
            typeName: "A",
          },
        },
        returnType: {
          kind: "type-var",
          typeName: "A",
        },
        arms: [
          {
            constructorName: "None",
            params: [],
            body: {
              kind: "systemF-var",
              name: "x",
            },
          },
        ],
      };
      const renamed = alphaRenameTypeBinder(term, "A", "B");
      assert.deepStrictEqual(renamed.kind, "systemF-match");
      const scrutinee = (
        renamed as {
          scrutinee: {
            kind: string;
            typeArg: { typeName: string };
          };
        }
      ).scrutinee;
      assert.deepStrictEqual(scrutinee.typeArg.typeName, "B");
      assert.deepStrictEqual(
        (renamed as { returnType: { typeName: string } }).returnType.typeName,
        "B",
      );
    });

    it("should recurse into systemF-let value and body for type binder rename", () => {
      const term: TripLangValueType = {
        kind: "systemF-let",
        name: "x",
        value: {
          kind: "systemF-type-app",
          term: { kind: "systemF-var", name: "f" },
          typeArg: { kind: "type-var", typeName: "A" },
        },
        body: { kind: "systemF-var", name: "x" },
      };
      const renamed = alphaRenameTypeBinder(term, "A", "B");
      assert.deepStrictEqual(renamed.kind, "systemF-let");
      assert.deepStrictEqual((renamed as { name: string }).name, "x");
      const value = (renamed as { value: TripLangValueType }).value;
      assert.deepStrictEqual(value.kind, "systemF-type-app");
      assert.deepStrictEqual(
        (value as { typeArg: { typeName: string } }).typeArg.typeName,
        "B",
      );
    });
  });

  describe("substituteHygienic", () => {
    it("should substitute variable without capture", () => {
      const term: TripLangValueType = {
        kind: "lambda-var",
        name: "x",
      };
      const replacement: TripLangValueType = {
        kind: "lambda-var",
        name: "y",
      };
      const result = substituteHygienic(term, "x", replacement);
      assert.deepStrictEqual(result.kind, "lambda-var");
      assert.deepStrictEqual((result as { name: string }).name, "y");
    });

    it("should avoid variable capture in lambda abstraction", () => {
      const term: TripLangValueType = {
        kind: "lambda-abs",
        name: "x",
        body: {
          kind: "lambda-var",
          name: "x",
        },
      };
      const replacement: TripLangValueType = {
        kind: "lambda-var",
        name: "x",
      };
      const result = substituteHygienic(term, "x", replacement);
      assert.deepStrictEqual(result.kind, "lambda-abs");
      // The binder should be renamed to avoid capture
      const binderName = (result as { name: string }).name;
      assert.deepStrictEqual(binderName !== "x", true);
      assert.deepStrictEqual(
        (result as { body: { name: string } }).body.name,
        binderName,
      );
    });

    it("should avoid variable capture in System F abstraction", () => {
      const term: TripLangValueType = {
        kind: "systemF-abs",
        name: "x",
        typeAnnotation: {
          kind: "type-var",
          typeName: "A",
        },
        body: {
          kind: "systemF-var",
          name: "x",
        },
      };
      const replacement: TripLangValueType = {
        kind: "systemF-var",
        name: "x",
      };
      const result = substituteHygienic(term, "x", replacement);
      assert.deepStrictEqual(result.kind, "systemF-abs");
      // The binder should be renamed to avoid capture
      const binderName = (result as { name: string }).name;
      assert.deepStrictEqual(binderName !== "x", true);
      assert.deepStrictEqual(
        (result as { body: { name: string } }).body.name,
        binderName,
      );
    });

    it("should substitute in nested structures", () => {
      const term: TripLangValueType = {
        kind: "non-terminal",
        lft: {
          kind: "lambda-var",
          name: "x",
        },
        rgt: {
          kind: "lambda-var",
          name: "y",
        },
      };
      const replacement: TripLangValueType = {
        kind: "lambda-var",
        name: "z",
      };
      const result = substituteHygienic(term, "x", replacement);
      assert.deepStrictEqual(result.kind, "non-terminal");
      assert.deepStrictEqual(
        (result as { lft: { name: string } }).lft.name,
        "z",
      );
      assert.deepStrictEqual(
        (result as { rgt: { name: string } }).rgt.name,
        "y",
      );
    });

    it("should not substitute bound variables", () => {
      const term: TripLangValueType = {
        kind: "lambda-abs",
        name: "x",
        body: {
          kind: "lambda-var",
          name: "x",
        },
      };
      const replacement: TripLangValueType = {
        kind: "lambda-var",
        name: "y",
      };
      const result = substituteHygienic(term, "x", replacement, new Set(["x"]));
      assert.deepStrictEqual(result.kind, "lambda-abs");
      assert.deepStrictEqual((result as { name: string }).name, "x");
      assert.deepStrictEqual(
        (result as { body: { name: string } }).body.name,
        "x",
      );
    });

    it("should handle complex nested substitution", () => {
      const term: TripLangValueType = {
        kind: "lambda-abs",
        name: "f",
        body: {
          kind: "lambda-abs",
          name: "x",
          body: {
            kind: "non-terminal",
            lft: {
              kind: "lambda-var",
              name: "f",
            },
            rgt: {
              kind: "lambda-var",
              name: "x",
            },
          },
        },
      };
      const replacement: TripLangValueType = {
        kind: "lambda-var",
        name: "g",
      };
      const result = substituteHygienic(term, "f", replacement);
      assert.deepStrictEqual(result.kind, "lambda-abs");
      assert.deepStrictEqual((result as { name: string }).name, "f");
      // The inner f should be substituted, but not the binder
      assert.deepStrictEqual(
        (result as { body: { body: { lft: { name: string } } } }).body.body.lft
          .name,
        "f",
      );
      assert.deepStrictEqual(
        (result as { body: { body: { rgt: { name: string } } } }).body.body.rgt
          .name,
        "x",
      );
    });

    it("should substitute in systemF-let value and body", () => {
      const term: TripLangValueType = {
        kind: "systemF-let",
        name: "x",
        value: { kind: "systemF-var", name: "y" },
        body: { kind: "systemF-var", name: "z" },
      };
      const replacement: TripLangValueType = {
        kind: "systemF-var",
        name: "w",
      };
      const resultY = substituteHygienic(term, "y", replacement);
      assert.deepStrictEqual(resultY.kind, "systemF-let");
      assert.deepStrictEqual((resultY as { name: string }).name, "x");
      assert.deepStrictEqual(
        (resultY as { value: { name: string } }).value.name,
        "w",
      );
      assert.deepStrictEqual(
        (resultY as { body: { name: string } }).body.name,
        "z",
      );

      const resultZ = substituteHygienic(term, "z", replacement);
      assert.deepStrictEqual(resultZ.kind, "systemF-let");
      assert.deepStrictEqual(
        (resultZ as { value: { name: string } }).value.name,
        "y",
      );
      assert.deepStrictEqual(
        (resultZ as { body: { name: string } }).body.name,
        "w",
      );
    });

    it("should avoid variable capture when substituting into systemF-let and replacement contains let binder", () => {
      const term: TripLangValueType = {
        kind: "systemF-let",
        name: "x",
        value: { kind: "systemF-var", name: "y" },
        body: { kind: "systemF-var", name: "x" },
      };
      const replacement: TripLangValueType = {
        kind: "systemF-var",
        name: "x",
      };
      const result = substituteHygienic(term, "y", replacement);
      assert.deepStrictEqual(result.kind, "systemF-let");
      const binderName = (result as { name: string }).name;
      assert.deepStrictEqual(binderName !== "x", true);
      assert.deepStrictEqual(
        (result as { value: { name: string } }).value.name,
        "x",
      );
      assert.deepStrictEqual(
        (result as { body: { name: string } }).body.name,
        binderName,
      );
    });
  });

  describe("substituteTypeHygienic", () => {
    it("should substitute type variable without capture", () => {
      const term: TripLangValueType = {
        kind: "type-var",
        typeName: "A",
      };
      const replacement: TripLangValueType = {
        kind: "type-var",
        typeName: "B",
      };
      const result = substituteTypeHygienic(term, "A", replacement);
      assert.deepStrictEqual(result.kind, "type-var");
      assert.deepStrictEqual((result as { typeName: string }).typeName, "B");
    });

    it("should avoid type variable capture in forall", () => {
      const term: TripLangValueType = {
        kind: "forall",
        typeVar: "A",
        body: {
          kind: "type-var",
          typeName: "A",
        },
      };
      const replacement: TripLangValueType = {
        kind: "type-var",
        typeName: "A",
      };
      const result = substituteTypeHygienic(term, "A", replacement);
      assert.deepStrictEqual(result.kind, "forall");
      // The binder should be renamed to avoid capture
      const binderName = (result as { typeVar: string }).typeVar;
      assert.deepStrictEqual(binderName !== "A", true);
      assert.deepStrictEqual(
        (result as { body: { typeName: string } }).body.typeName,
        binderName,
      );
    });

    it("should avoid type variable capture in System F type abstraction", () => {
      const term: TripLangValueType = {
        kind: "systemF-type-abs",
        typeVar: "A",
        body: {
          kind: "systemF-var",
          name: "x",
        },
      };
      const replacement: TripLangValueType = {
        kind: "type-var",
        typeName: "B",
      };
      const result = substituteTypeHygienic(term, "A", replacement);
      assert.deepStrictEqual(result.kind, "systemF-type-abs");
      // The binder should remain unchanged since there's no capture
      const binderName = (result as { typeVar: string }).typeVar;
      assert.deepStrictEqual(binderName, "A");
      // The body should remain unchanged since it doesn't contain the type variable
      assert.deepStrictEqual(
        (result as { body: { name: string } }).body.name,
        "x",
      );
    });

    it("should substitute in nested type structures", () => {
      const term: TripLangValueType = {
        kind: "systemF-type-app",
        term: {
          kind: "systemF-var",
          name: "x",
        },
        typeArg: {
          kind: "type-var",
          typeName: "B",
        },
      };
      const replacement: TripLangValueType = {
        kind: "type-var",
        typeName: "C",
      };
      const result = substituteTypeHygienic(term, "A", replacement);
      assert.deepStrictEqual(result.kind, "systemF-type-app");
      // The term should remain unchanged since it doesn't contain the type variable
      assert.deepStrictEqual(
        (result as { term: { name: string } }).term.name,
        "x",
      );
      assert.deepStrictEqual(
        (result as { typeArg: { typeName: string } }).typeArg.typeName,
        "B",
      );
    });

    it("should recurse into systemF-let value and body for type substitution", () => {
      const term: TripLangValueType = {
        kind: "systemF-let",
        name: "x",
        value: {
          kind: "systemF-type-app",
          term: { kind: "systemF-var", name: "f" },
          typeArg: { kind: "type-var", typeName: "A" },
        },
        body: { kind: "systemF-var", name: "x" },
      };
      const replacement: TripLangValueType = {
        kind: "type-var",
        typeName: "B",
      };
      const result = substituteTypeHygienic(term, "A", replacement);
      assert.deepStrictEqual(result.kind, "systemF-let");
      assert.deepStrictEqual((result as { name: string }).name, "x");
      const value = (result as { value: TripLangValueType }).value;
      assert.deepStrictEqual(value.kind, "systemF-type-app");
      assert.deepStrictEqual(
        (value as { typeArg: { typeName: string } }).typeArg.typeName,
        "B",
      );
      assert.deepStrictEqual(
        (result as { body: { name: string } }).body.name,
        "x",
      );
    });

    it("should not substitute bound type variables", () => {
      const term: TripLangValueType = {
        kind: "forall",
        typeVar: "A",
        body: {
          kind: "type-var",
          typeName: "A",
        },
      };
      const replacement: TripLangValueType = {
        kind: "type-var",
        typeName: "B",
      };
      const result = substituteTypeHygienic(
        term,
        "A",
        replacement,
        new Set(["A"]),
      );
      assert.deepStrictEqual(result.kind, "forall");
      assert.deepStrictEqual((result as { typeVar: string }).typeVar, "A");
      assert.deepStrictEqual(
        (result as { body: { typeName: string } }).body.typeName,
        "A",
      );
    });

    it("should handle complex nested type substitution", () => {
      const term: TripLangValueType = {
        kind: "systemF-abs",
        name: "x",
        typeAnnotation: {
          kind: "forall",
          typeVar: "A",
          body: {
            kind: "type-var",
            typeName: "A",
          },
        },
        body: {
          kind: "systemF-var",
          name: "x",
        },
      };
      const replacement: TripLangValueType = {
        kind: "type-var",
        typeName: "B",
      };
      const result = substituteTypeHygienic(term, "A", replacement);
      assert.deepStrictEqual(result.kind, "systemF-abs");
      // The inner A should be substituted, but not the binder
      const typeAnnotation = (
        result as {
          typeAnnotation: {
            kind: string;
            typeVar: string;
            body: { typeName: string };
          };
        }
      ).typeAnnotation;
      assert.deepStrictEqual(typeAnnotation.kind, "forall");
      const binderName = typeAnnotation.typeVar;
      assert.deepStrictEqual(binderName, "A");
      assert.deepStrictEqual(typeAnnotation.body.typeName, "A");
    });
  });

  describe("edge cases", () => {
    it("should handle empty bound set", () => {
      const term: TripLangValueType = {
        kind: "lambda-var",
        name: "x",
      };
      const replacement: TripLangValueType = {
        kind: "lambda-var",
        name: "y",
      };
      const result = substituteHygienic(term, "x", replacement, new Set());
      assert.deepStrictEqual(result.kind, "lambda-var");
      assert.deepStrictEqual((result as { name: string }).name, "y");
    });

    it("should handle non-matching variable names", () => {
      const term: TripLangValueType = {
        kind: "lambda-var",
        name: "x",
      };
      const replacement: TripLangValueType = {
        kind: "lambda-var",
        name: "y",
      };
      const result = substituteHygienic(term, "z", replacement);
      assert.deepStrictEqual(result.kind, "lambda-var");
      assert.deepStrictEqual((result as { name: string }).name, "x");
    });

    it("should handle terminal nodes", () => {
      const term: TripLangValueType = {
        kind: "terminal",
        sym: SKITerminalSymbol.S,
      };
      const replacement: TripLangValueType = {
        kind: "lambda-var",
        name: "x",
      };
      const result = substituteHygienic(term, "x", replacement);
      assert.deepStrictEqual(result.kind, "terminal");
    });

    it("should handle type variables in term substitution", () => {
      const term: TripLangValueType = {
        kind: "type-var",
        typeName: "A",
      };
      const replacement: TripLangValueType = {
        kind: "lambda-var",
        name: "x",
      };
      const result = substituteHygienic(term, "x", replacement);
      assert.deepStrictEqual(result.kind, "type-var");
      assert.deepStrictEqual((result as { typeName: string }).typeName, "A");
    });

    it("should substitute in match expression", () => {
      const term: TripLangValueType = {
        kind: "systemF-match",
        scrutinee: {
          kind: "systemF-var",
          name: "x",
        },
        returnType: {
          kind: "type-var",
          typeName: "T",
        },
        arms: [
          {
            constructorName: "Cons",
            params: ["a", "b"],
            body: {
              kind: "systemF-var",
              name: "x",
            },
          },
        ],
      };
      const replacement: TripLangValueType = {
        kind: "systemF-var",
        name: "y",
      };
      const result = substituteHygienic(term, "x", replacement);
      assert.deepStrictEqual(result.kind, "systemF-match");
      assert.deepStrictEqual(
        (result as { scrutinee: { name: string } }).scrutinee.name,
        "y",
      );
      // The x in the match arm body should be substituted
      assert.deepStrictEqual(
        requiredAt(
          (result as { arms: Array<{ body: { name: string } }> }).arms,
          0,
          "expected first match arm",
        ).body.name,
        "y",
      );
    });

    it("should avoid variable capture in match arm parameters", () => {
      const term: TripLangValueType = {
        kind: "systemF-match",
        scrutinee: {
          kind: "systemF-var",
          name: "m",
        },
        returnType: {
          kind: "type-var",
          typeName: "T",
        },
        arms: [
          {
            constructorName: "Some",
            params: ["x"],
            body: {
              kind: "systemF-var",
              name: "x",
            },
          },
        ],
      };
      const replacement: TripLangValueType = {
        kind: "systemF-var",
        name: "x",
      };
      const result = substituteHygienic(term, "m", replacement);
      assert.deepStrictEqual(result.kind, "systemF-match");
      assert.deepStrictEqual(
        (result as { scrutinee: { name: string } }).scrutinee.name,
        "x",
      );
      // The match arm parameter 'x' should be renamed to avoid capture
      const arm = requiredAt(
        (
          result as {
            arms: Array<{ params: string[]; body: { name: string } }>;
          }
        ).arms,
        0,
        "expected first match arm",
      );
      const param0 = requiredAt(arm.params, 0, "expected first arm parameter");
      assert.deepStrictEqual(param0 !== "x", true); // Should be renamed
      assert.deepStrictEqual(arm.body.name, param0); // Body should reference renamed param
    });

    it("should substitute in match scrutinee and return type", () => {
      const term: TripLangValueType = {
        kind: "systemF-match",
        scrutinee: {
          kind: "systemF-var",
          name: "x",
        },
        returnType: {
          kind: "type-var",
          typeName: "T",
        },
        arms: [
          {
            constructorName: "None",
            params: [],
            body: {
              kind: "systemF-var",
              name: "y",
            },
          },
        ],
      };
      const replacement: TripLangValueType = {
        kind: "systemF-var",
        name: "z",
      };
      const result = substituteHygienic(term, "x", replacement);
      assert.deepStrictEqual(result.kind, "systemF-match");
      assert.deepStrictEqual(
        (result as { scrutinee: { name: string } }).scrutinee.name,
        "z",
      );
      // Return type should remain unchanged since it's a type-var, not a term variable
      const returnType = (
        result as {
          returnType: { typeName: string };
        }
      ).returnType;
      assert.deepStrictEqual(returnType.typeName, "T");
    });

    it("should handle multiple match arms with different parameter names", () => {
      const term: TripLangValueType = {
        kind: "systemF-match",
        scrutinee: {
          kind: "systemF-var",
          name: "m",
        },
        returnType: {
          kind: "type-var",
          typeName: "T",
        },
        arms: [
          {
            constructorName: "Some",
            params: ["x"],
            body: {
              kind: "systemF-var",
              name: "x",
            },
          },
          {
            constructorName: "None",
            params: [],
            body: {
              kind: "systemF-var",
              name: "y",
            },
          },
        ],
      };
      const replacement: TripLangValueType = {
        kind: "systemF-var",
        name: "z",
      };
      const result = substituteHygienic(term, "y", replacement);
      assert.deepStrictEqual(result.kind, "systemF-match");
      const arms = (
        result as {
          arms: Array<{ params: string[]; body: { name: string } }>;
        }
      ).arms;
      assert.deepStrictEqual(
        requiredAt(arms, 0, "expected first match arm").body.name,
        "x",
      ); // Should remain unchanged
      assert.deepStrictEqual(
        requiredAt(arms, 1, "expected second match arm").body.name,
        "z",
      ); // Should be substituted
    });

    it("should rename multiple match arm parameters to avoid capture", () => {
      const term: TripLangValueType = {
        kind: "systemF-match",
        scrutinee: {
          kind: "systemF-var",
          name: "m",
        },
        returnType: {
          kind: "type-var",
          typeName: "T",
        },
        arms: [
          {
            constructorName: "Cons",
            params: ["x", "y"],
            body: {
              kind: "non-terminal",
              lft: {
                kind: "systemF-var",
                name: "x",
              },
              rgt: {
                kind: "systemF-var",
                name: "y",
              },
            },
          },
        ],
      };
      const replacement: TripLangValueType = {
        kind: "non-terminal",
        lft: {
          kind: "systemF-var",
          name: "x",
        },
        rgt: {
          kind: "systemF-var",
          name: "y",
        },
      };
      const result = substituteHygienic(term, "m", replacement);
      assert.deepStrictEqual(result.kind, "systemF-match");
      const arm = requiredAt(
        (
          result as {
            arms: Array<{
              params: string[];
              body: { lft: { name: string }; rgt: { name: string } };
            }>;
          }
        ).arms,
        0,
        "expected first match arm",
      );
      // Both parameters should be renamed
      const param0 = requiredAt(arm.params, 0, "expected first arm parameter");
      const param1 = requiredAt(arm.params, 1, "expected second arm parameter");
      assert.deepStrictEqual(param0 !== "x", true);
      assert.deepStrictEqual(param1 !== "y", true);
      assert.deepStrictEqual(arm.body.lft.name, param0);
      assert.deepStrictEqual(arm.body.rgt.name, param1);
    });
  });

  describe("substituteTypeHygienic - systemF-match", () => {
    it("should substitute type variables in match expression", () => {
      const term: TripLangValueType = {
        kind: "systemF-match",
        scrutinee: {
          kind: "systemF-var",
          name: "x",
        },
        returnType: {
          kind: "type-var",
          typeName: "A",
        },
        arms: [
          {
            constructorName: "Some",
            params: ["a"],
            body: {
              kind: "systemF-var",
              name: "a",
            },
          },
        ],
      };
      const replacement: TripLangValueType = {
        kind: "type-var",
        typeName: "B",
      };
      const result = substituteTypeHygienic(term, "A", replacement);
      assert.deepStrictEqual(result.kind, "systemF-match");
      assert.deepStrictEqual(
        (result as { returnType: { typeName: string } }).returnType.typeName,
        "B",
      );
    });

    it("should substitute type variables in match scrutinee and arms", () => {
      const term: TripLangValueType = {
        kind: "systemF-match",
        scrutinee: {
          kind: "systemF-type-app",
          term: {
            kind: "systemF-var",
            name: "x",
          },
          typeArg: {
            kind: "type-var",
            typeName: "A",
          },
        },
        returnType: {
          kind: "type-var",
          typeName: "A",
        },
        arms: [
          {
            constructorName: "Some",
            params: ["a"],
            body: {
              kind: "systemF-type-app",
              term: {
                kind: "systemF-var",
                name: "a",
              },
              typeArg: {
                kind: "type-var",
                typeName: "A",
              },
            },
          },
        ],
      };
      const replacement: TripLangValueType = {
        kind: "type-var",
        typeName: "B",
      };
      const result = substituteTypeHygienic(term, "A", replacement);
      assert.deepStrictEqual(result.kind, "systemF-match");
      const scrutinee = (
        result as {
          scrutinee: {
            kind: string;
            typeArg: { typeName: string };
          };
        }
      ).scrutinee;
      assert.deepStrictEqual(scrutinee.typeArg.typeName, "B");
      assert.deepStrictEqual(
        (result as { returnType: { typeName: string } }).returnType.typeName,
        "B",
      );
      const arm = requiredAt(
        (
          result as {
            arms: Array<{
              body: {
                kind: string;
                typeArg: { typeName: string };
              };
            }>;
          }
        ).arms,
        0,
        "expected first match arm",
      );
      assert.deepStrictEqual(arm.body.typeArg.typeName, "B");
    });

    it("should not substitute bound type variables in match arms", () => {
      const term: TripLangValueType = {
        kind: "systemF-type-abs",
        typeVar: "A",
        body: {
          kind: "systemF-match",
          scrutinee: {
            kind: "systemF-var",
            name: "x",
          },
          returnType: {
            kind: "type-var",
            typeName: "A",
          },
          arms: [
            {
              constructorName: "None",
              params: [],
              body: {
                kind: "systemF-var",
                name: "x",
              },
            },
          ],
        },
      };
      const replacement: TripLangValueType = {
        kind: "type-var",
        typeName: "B",
      };
      const result = substituteTypeHygienic(term, "A", replacement);
      assert.deepStrictEqual(result.kind, "systemF-type-abs");
      const match = (
        result as {
          body: {
            kind: string;
            returnType: { typeName: string };
          };
        }
      ).body;
      assert.deepStrictEqual(match.kind, "systemF-match");
      // The A in returnType should remain A because it's bound by the outer type abstraction
      assert.deepStrictEqual(match.returnType.typeName, "A");
    });
  });
});
