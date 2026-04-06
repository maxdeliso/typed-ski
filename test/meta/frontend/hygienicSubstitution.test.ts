import { test } from "node:test";
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

test("hygienic substitution functions", async (t) => {
  await t.test("freeTermVars", async (t) => {
    await t.test("should identify free variables in lambda abstraction", () => {
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

    await t.test(
      "should identify free variables in System F abstraction",
      () => {
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
      },
    );

    await t.test(
      "should identify free variables in nested abstractions",
      () => {
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
      },
    );

    await t.test("should identify free variables in type abstractions", () => {
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

    await t.test("should identify free variables in applications", () => {
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

    await t.test("should identify free variables in match expression", () => {
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

    await t.test(
      "should not count match arm parameters as free variables",
      () => {
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
      },
    );

    await t.test("should identify free variables in systemF-let", () => {
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

    await t.test("should not count systemF-let binder as free in body", () => {
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

  await t.test("freeTypeVars", async (t) => {
    await t.test("should identify free type variables", () => {
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

    await t.test(
      "should identify free type variables in nested abstractions",
      () => {
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
      },
    );

    await t.test(
      "should identify free type variables in match expression",
      () => {
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
                name: "a",
              },
            },
          ],
        };
        const free = freeTypeVars(term);
        assert.deepStrictEqual(free.size, 1);
        assert.deepStrictEqual(free.has("T"), true);
      },
    );

    await t.test(
      "should not count bound type variables in match expression",
      () => {
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
              typeName: "A", // Bound by outer type abstraction
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
        const free = freeTypeVars(term);
        assert.deepStrictEqual(free.size, 0);
        assert.deepStrictEqual(free.has("A"), false);
      },
    );

    await t.test("should identify free type variables in systemF-let", () => {
      const term: TripLangValueType = {
        kind: "systemF-let",
        name: "x",
        value: {
          kind: "systemF-abs",
          name: "z",
          typeAnnotation: { kind: "type-var", typeName: "A" },
          body: { kind: "systemF-var", name: "z" },
        },
        body: { kind: "systemF-var", name: "x" },
      };
      const free = freeTypeVars(term);
      assert.deepStrictEqual(free.size, 1);
      assert.deepStrictEqual(free.has("A"), true);
    });
  });

  await t.test("fresh", async (t) => {
    await t.test("should generate fresh names avoiding conflicts", () => {
      const avoid = new Set(["x", "x_0", "x_1"]);
      const freshName = fresh("x", avoid);
      assert.deepStrictEqual(freshName, "x_2");
    });

    await t.test("should return original name if no conflicts", () => {
      const avoid = new Set(["y", "z"]);
      const freshName = fresh("x", avoid);
      assert.deepStrictEqual(freshName, "x");
    });

    await t.test("should handle empty avoid set", () => {
      const avoid = new Set<string>();
      const freshName = fresh("x", avoid);
      assert.deepStrictEqual(freshName, "x");
    });
  });

  await t.test("alphaRenameTermBinder", async (t) => {
    await t.test("should rename lambda binder", () => {
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

    await t.test("should rename System F binder", () => {
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

    await t.test("should rename typed lambda binder", () => {
      const term: TripLangValueType = {
        kind: "typed-lambda-abstraction",
        varName: "x",
        ty: {
          kind: "type-var",
          typeName: "A",
        },
        body: {
          kind: "lambda-var",
          name: "x",
        },
      };
      const renamed = alphaRenameTermBinder(term, "x", "y");
      assert.deepStrictEqual(renamed.kind, "typed-lambda-abstraction");
      assert.deepStrictEqual((renamed as { varName: string }).varName, "y");
      assert.deepStrictEqual(
        (renamed as { body: { name: string } }).body.name,
        "y",
      );
    });

    await t.test("should not rename if binder name doesn't match", () => {
      const term: TripLangValueType = {
        kind: "lambda-abs",
        name: "x",
        body: {
          kind: "lambda-var",
          name: "x",
        },
      };
      const renamed = alphaRenameTermBinder(term, "y", "z");
      assert.deepStrictEqual(renamed.kind, "lambda-abs");
      assert.deepStrictEqual((renamed as { name: string }).name, "x");
      assert.deepStrictEqual(
        (renamed as { body: { name: string } }).body.name,
        "x",
      );
    });

    await t.test("should stop renaming under shadowing binder", () => {
      const term: TripLangValueType = {
        kind: "lambda-abs",
        name: "x",
        body: {
          kind: "lambda-abs",
          name: "y",
          body: {
            kind: "lambda-var",
            name: "x",
          },
        },
      };
      const renamed = alphaRenameTermBinder(term, "x", "y");
      assert.deepStrictEqual(renamed.kind, "lambda-abs");
      assert.deepStrictEqual((renamed as { name: string }).name, "y");
      // Inner x should not be renamed due to shadowing
      assert.deepStrictEqual(
        (renamed as { body: { body: { name: string } } }).body.body.name,
        "x",
      );
    });

    await t.test("should rename term binders in match expression", () => {
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
            params: ["x"],
            body: {
              kind: "systemF-var",
              name: "x",
            },
          },
        ],
      };
      const renamed = alphaRenameTermBinder(term, "x", "y");
      assert.deepStrictEqual(renamed.kind, "systemF-match");
      assert.deepStrictEqual(
        (renamed as { scrutinee: { name: string } }).scrutinee.name,
        "y",
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
        "y",
      );
      assert.deepStrictEqual(arm.body.name, "y");
    });

    await t.test(
      "should rename match arm parameters when they match oldName",
      () => {
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
              params: ["a", "x"],
              body: {
                kind: "systemF-var",
                name: "x",
              },
            },
          ],
        };
        const renamed = alphaRenameTermBinder(term, "x", "y");
        assert.deepStrictEqual(renamed.kind, "systemF-match");
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
        assert.deepStrictEqual(
          requiredAt(arm.params, 1, "expected second arm parameter"),
          "y",
        );
        assert.deepStrictEqual(arm.body.name, "y");
      },
    );

    await t.test(
      "should not rename match arm parameters when newName already exists",
      () => {
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
              params: ["x", "y"],
              body: {
                kind: "systemF-var",
                name: "x",
              },
            },
          ],
        };
        const renamed = alphaRenameTermBinder(term, "x", "y");
        assert.deepStrictEqual(renamed.kind, "systemF-match");
        const arm = requiredAt(
          (
            renamed as {
              arms: Array<{ params: string[]; body: { name: string } }>;
            }
          ).arms,
          0,
          "expected first match arm",
        );
        // Should not rename because "y" already exists in params
        assert.deepStrictEqual(
          requiredAt(arm.params, 0, "expected first arm parameter"),
          "x",
        );
        assert.deepStrictEqual(
          requiredAt(arm.params, 1, "expected second arm parameter"),
          "y",
        );
        assert.deepStrictEqual(arm.body.name, "x");
      },
    );

    await t.test(
      "should rename in match arm body when param doesn't match",
      () => {
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
              params: ["a"],
              body: {
                kind: "systemF-var",
                name: "x",
              },
            },
          ],
        };
        const renamed = alphaRenameTermBinder(term, "x", "y");
        assert.deepStrictEqual(renamed.kind, "systemF-match");
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
        assert.deepStrictEqual(arm.body.name, "y");
      },
    );

    await t.test("should rename systemF-let binder", () => {
      const term: TripLangValueType = {
        kind: "systemF-let",
        name: "x",
        value: { kind: "systemF-var", name: "a" },
        body: { kind: "systemF-var", name: "x" },
      };
      const renamed = alphaRenameTermBinder(term, "x", "y");
      assert.deepStrictEqual(renamed.kind, "systemF-let");
      assert.deepStrictEqual((renamed as { name: string }).name, "y");
      assert.deepStrictEqual(
        (renamed as { value: { name: string } }).value.name,
        "a",
      );
      assert.deepStrictEqual(
        (renamed as { body: { name: string } }).body.name,
        "y",
      );
    });

    await t.test(
      "should not rename systemF-let binder when name doesn't match",
      () => {
        const term: TripLangValueType = {
          kind: "systemF-let",
          name: "x",
          value: { kind: "systemF-var", name: "a" },
          body: { kind: "systemF-var", name: "x" },
        };
        const renamed = alphaRenameTermBinder(term, "z", "w");
        assert.deepStrictEqual(renamed.kind, "systemF-let");
        assert.deepStrictEqual((renamed as { name: string }).name, "x");
        assert.deepStrictEqual(
          (renamed as { body: { name: string } }).body.name,
          "x",
        );
      },
    );

    await t.test(
      "should rename free occurrence in systemF-let value and body when binder doesn't match",
      () => {
        const term: TripLangValueType = {
          kind: "systemF-let",
          name: "y",
          value: { kind: "systemF-var", name: "x" },
          body: { kind: "systemF-var", name: "y" },
        };
        const renamed = alphaRenameTermBinder(term, "x", "z");
        assert.deepStrictEqual(renamed.kind, "systemF-let");
        assert.deepStrictEqual((renamed as { name: string }).name, "y");
        assert.deepStrictEqual(
          (renamed as { value: { name: string } }).value.name,
          "z",
        );
        assert.deepStrictEqual(
          (renamed as { body: { name: string } }).body.name,
          "y",
        );
      },
    );

    await t.test(
      "should rename nested systemF-let binders when both bind same name (no early exit for newName)",
      () => {
        const term: TripLangValueType = {
          kind: "systemF-let",
          name: "x",
          value: { kind: "systemF-var", name: "a" },
          body: {
            kind: "systemF-let",
            name: "x",
            value: { kind: "systemF-var", name: "b" },
            body: { kind: "systemF-var", name: "x" },
          },
        };
        const renamed = alphaRenameTermBinder(term, "x", "y");
        assert.deepStrictEqual(renamed.kind, "systemF-let");
        assert.deepStrictEqual((renamed as { name: string }).name, "y");
        const inner = (renamed as { body: TripLangValueType }).body;
        assert.deepStrictEqual(inner.kind, "systemF-let");
        assert.deepStrictEqual((inner as { name: string }).name, "y");
        assert.deepStrictEqual(
          (inner as { body: { name: string } }).body.name,
          "y",
        );
      },
    );
  });

  await t.test("alphaRenameTypeBinder", async (t) => {
    await t.test("should rename forall binder", () => {
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

    await t.test("should rename System F type binder", () => {
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

    await t.test("should not rename if binder name doesn't match", () => {
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

    await t.test("should rename type variables in match expression", () => {
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

    await t.test(
      "should rename type variables in match scrutinee and return type",
      () => {
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
      },
    );

    await t.test(
      "should recurse into systemF-let value and body for type binder rename",
      () => {
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
      },
    );
  });

  await t.test("substituteHygienic", async (t) => {
    await t.test("should substitute variable without capture", () => {
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

    await t.test("should avoid variable capture in lambda abstraction", () => {
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

    await t.test(
      "should avoid variable capture in System F abstraction",
      () => {
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
      },
    );

    await t.test("should substitute in nested structures", () => {
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

    await t.test("should not substitute bound variables", () => {
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

    await t.test("should handle complex nested substitution", () => {
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

    await t.test("should substitute in systemF-let value and body", () => {
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

    await t.test(
      "should avoid variable capture when substituting into systemF-let and replacement contains let binder",
      () => {
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
      },
    );
  });

  await t.test("substituteTypeHygienic", async (t) => {
    await t.test("should substitute type variable without capture", () => {
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

    await t.test("should avoid type variable capture in forall", () => {
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

    await t.test(
      "should avoid type variable capture in System F type abstraction",
      () => {
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
      },
    );

    await t.test("should substitute in nested type structures", () => {
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

    await t.test(
      "should recurse into systemF-let value and body for type substitution",
      () => {
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
      },
    );

    await t.test("should not substitute bound type variables", () => {
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

    await t.test("should handle complex nested type substitution", () => {
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

  await t.test("edge cases", async (t) => {
    await t.test("should handle empty bound set", () => {
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

    await t.test("should handle non-matching variable names", () => {
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

    await t.test("should handle terminal nodes", () => {
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

    await t.test("should handle type variables in term substitution", () => {
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

    await t.test("should substitute in match expression", () => {
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

    await t.test(
      "should avoid variable capture in match arm parameters",
      () => {
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
        const param0 = requiredAt(
          arm.params,
          0,
          "expected first arm parameter",
        );
        assert.deepStrictEqual(param0 !== "x", true); // Should be renamed
        assert.deepStrictEqual(arm.body.name, param0); // Body should reference renamed param
      },
    );

    await t.test("should substitute in match scrutinee and return type", () => {
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

    await t.test(
      "should handle multiple match arms with different parameter names",
      () => {
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
      },
    );

    await t.test(
      "should rename multiple match arm parameters to avoid capture",
      () => {
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
        const param0 = requiredAt(
          arm.params,
          0,
          "expected first arm parameter",
        );
        const param1 = requiredAt(
          arm.params,
          1,
          "expected second arm parameter",
        );
        assert.deepStrictEqual(param0 !== "x", true);
        assert.deepStrictEqual(param1 !== "y", true);
        assert.deepStrictEqual(arm.body.lft.name, param0);
        assert.deepStrictEqual(arm.body.rgt.name, param1);
      },
    );
  });

  await t.test("substituteTypeHygienic - systemF-match", async (t) => {
    await t.test("should substitute type variables in match expression", () => {
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

    await t.test(
      "should substitute type variables in match scrutinee and arms",
      () => {
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
      },
    );

    await t.test(
      "should not substitute bound type variables in match arms",
      () => {
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
      },
    );
  });
});
