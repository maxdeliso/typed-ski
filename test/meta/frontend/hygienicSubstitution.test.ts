/**
 * Tests for hygienic substitution functions
 *
 * This module tests the hygienic substitution algorithms that avoid variable
 * capture by tracking bound variables and performing alpha-renaming when necessary.
 */

import { assertEquals } from "std/assert";
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

Deno.test("hygienic substitution functions", async (t) => {
  await t.step("freeTermVars", async (t) => {
    await t.step("should identify free variables in lambda abstraction", () => {
      const term: TripLangValueType = {
        kind: "lambda-abs",
        name: "x",
        body: {
          kind: "lambda-var",
          name: "y",
        },
      };
      const free = freeTermVars(term);
      assertEquals(free.size, 1);
      assertEquals(free.has("y"), true);
      assertEquals(free.has("x"), false);
    });

    await t.step(
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
        assertEquals(free.size, 1);
        assertEquals(free.has("y"), true);
        assertEquals(free.has("x"), false);
      },
    );

    await t.step(
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
        assertEquals(free.size, 1);
        assertEquals(free.has("z"), true);
        assertEquals(free.has("x"), false);
        assertEquals(free.has("y"), false);
      },
    );

    await t.step("should identify free variables in type abstractions", () => {
      const term: TripLangValueType = {
        kind: "systemF-type-abs",
        typeVar: "A",
        body: {
          kind: "systemF-var",
          name: "x",
        },
      };
      const free = freeTermVars(term);
      assertEquals(free.size, 1);
      assertEquals(free.has("x"), true);
    });

    await t.step("should identify free variables in applications", () => {
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
      assertEquals(free.size, 2);
      assertEquals(free.has("f"), true);
      assertEquals(free.has("x"), true);
    });

    await t.step("should identify free variables in match expression", () => {
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
      assertEquals(free.size, 3);
      assertEquals(free.has("x"), true);
      assertEquals(free.has("y"), true);
      assertEquals(free.has("z"), true);
      assertEquals(free.has("a"), false); // Bound in match arm
    });

    await t.step(
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
        assertEquals(free.size, 1);
        assertEquals(free.has("m"), true);
        assertEquals(free.has("a"), false);
        assertEquals(free.has("b"), false);
      },
    );

    await t.step("should identify free variables in systemF-let", () => {
      const term: TripLangValueType = {
        kind: "systemF-let",
        name: "x",
        value: { kind: "systemF-var", name: "y" },
        body: { kind: "systemF-var", name: "z" },
      };
      const free = freeTermVars(term);
      assertEquals(free.size, 2);
      assertEquals(free.has("y"), true);
      assertEquals(free.has("z"), true);
      assertEquals(free.has("x"), false);
    });

    await t.step(
      "should not count systemF-let binder as free in body",
      () => {
        const term: TripLangValueType = {
          kind: "systemF-let",
          name: "x",
          value: { kind: "systemF-var", name: "y" },
          body: { kind: "systemF-var", name: "x" },
        };
        const free = freeTermVars(term);
        assertEquals(free.size, 1);
        assertEquals(free.has("y"), true);
        assertEquals(free.has("x"), false);
      },
    );
  });

  await t.step("freeTypeVars", async (t) => {
    await t.step("should identify free type variables", () => {
      const term: TripLangValueType = {
        kind: "systemF-type-abs",
        typeVar: "A",
        body: {
          kind: "systemF-var",
          name: "x",
        },
      };
      const free = freeTypeVars(term);
      assertEquals(free.size, 0);
      assertEquals(free.has("x"), false);
      assertEquals(free.has("A"), false);
    });

    await t.step(
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
        assertEquals(free.size, 0);
        assertEquals(free.has("x"), false);
        assertEquals(free.has("A"), false);
        assertEquals(free.has("B"), false);
      },
    );

    await t.step(
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
        assertEquals(free.size, 1);
        assertEquals(free.has("T"), true);
      },
    );

    await t.step(
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
        assertEquals(free.size, 0);
        assertEquals(free.has("A"), false);
      },
    );

    await t.step("should identify free type variables in systemF-let", () => {
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
      assertEquals(free.size, 1);
      assertEquals(free.has("A"), true);
    });
  });

  await t.step("fresh", async (t) => {
    await t.step("should generate fresh names avoiding conflicts", () => {
      const avoid = new Set(["x", "x_0", "x_1"]);
      const freshName = fresh("x", avoid);
      assertEquals(freshName, "x_2");
    });

    await t.step("should return original name if no conflicts", () => {
      const avoid = new Set(["y", "z"]);
      const freshName = fresh("x", avoid);
      assertEquals(freshName, "x");
    });

    await t.step("should handle empty avoid set", () => {
      const avoid = new Set<string>();
      const freshName = fresh("x", avoid);
      assertEquals(freshName, "x");
    });
  });

  await t.step("alphaRenameTermBinder", async (t) => {
    await t.step("should rename lambda binder", () => {
      const term: TripLangValueType = {
        kind: "lambda-abs",
        name: "x",
        body: {
          kind: "lambda-var",
          name: "x",
        },
      };
      const renamed = alphaRenameTermBinder(term, "x", "y");
      assertEquals(renamed.kind, "lambda-abs");
      assertEquals((renamed as { name: string }).name, "y");
      assertEquals((renamed as { body: { name: string } }).body.name, "y");
    });

    await t.step("should rename System F binder", () => {
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
      assertEquals(renamed.kind, "systemF-abs");
      assertEquals((renamed as { name: string }).name, "y");
      assertEquals((renamed as { body: { name: string } }).body.name, "y");
    });

    await t.step("should rename typed lambda binder", () => {
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
      assertEquals(renamed.kind, "typed-lambda-abstraction");
      assertEquals((renamed as { varName: string }).varName, "y");
      assertEquals((renamed as { body: { name: string } }).body.name, "y");
    });

    await t.step("should not rename if binder name doesn't match", () => {
      const term: TripLangValueType = {
        kind: "lambda-abs",
        name: "x",
        body: {
          kind: "lambda-var",
          name: "x",
        },
      };
      const renamed = alphaRenameTermBinder(term, "y", "z");
      assertEquals(renamed.kind, "lambda-abs");
      assertEquals((renamed as { name: string }).name, "x");
      assertEquals((renamed as { body: { name: string } }).body.name, "x");
    });

    await t.step("should stop renaming under shadowing binder", () => {
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
      assertEquals(renamed.kind, "lambda-abs");
      assertEquals((renamed as { name: string }).name, "y");
      // Inner x should not be renamed due to shadowing
      assertEquals(
        (renamed as { body: { body: { name: string } } }).body.body.name,
        "x",
      );
    });

    await t.step("should rename term binders in match expression", () => {
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
      assertEquals(renamed.kind, "systemF-match");
      assertEquals(
        (renamed as { scrutinee: { name: string } }).scrutinee.name,
        "y",
      );
      const arm = (renamed as {
        arms: Array<{ params: string[]; body: { name: string } }>;
      }).arms[0];
      assertEquals(arm.params[0], "y");
      assertEquals(arm.body.name, "y");
    });

    await t.step(
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
        assertEquals(renamed.kind, "systemF-match");
        const arm = (renamed as {
          arms: Array<{ params: string[]; body: { name: string } }>;
        }).arms[0];
        assertEquals(arm.params[0], "a");
        assertEquals(arm.params[1], "y");
        assertEquals(arm.body.name, "y");
      },
    );

    await t.step(
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
        assertEquals(renamed.kind, "systemF-match");
        const arm = (renamed as {
          arms: Array<{ params: string[]; body: { name: string } }>;
        }).arms[0];
        // Should not rename because "y" already exists in params
        assertEquals(arm.params[0], "x");
        assertEquals(arm.params[1], "y");
        assertEquals(arm.body.name, "x");
      },
    );

    await t.step(
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
        assertEquals(renamed.kind, "systemF-match");
        const arm = (renamed as {
          arms: Array<{ params: string[]; body: { name: string } }>;
        }).arms[0];
        assertEquals(arm.params[0], "a");
        assertEquals(arm.body.name, "y");
      },
    );

    await t.step("should rename systemF-let binder", () => {
      const term: TripLangValueType = {
        kind: "systemF-let",
        name: "x",
        value: { kind: "systemF-var", name: "a" },
        body: { kind: "systemF-var", name: "x" },
      };
      const renamed = alphaRenameTermBinder(term, "x", "y");
      assertEquals(renamed.kind, "systemF-let");
      assertEquals((renamed as { name: string }).name, "y");
      assertEquals((renamed as { value: { name: string } }).value.name, "a");
      assertEquals((renamed as { body: { name: string } }).body.name, "y");
    });

    await t.step(
      "should not rename systemF-let binder when name doesn't match",
      () => {
        const term: TripLangValueType = {
          kind: "systemF-let",
          name: "x",
          value: { kind: "systemF-var", name: "a" },
          body: { kind: "systemF-var", name: "x" },
        };
        const renamed = alphaRenameTermBinder(term, "z", "w");
        assertEquals(renamed.kind, "systemF-let");
        assertEquals((renamed as { name: string }).name, "x");
        assertEquals((renamed as { body: { name: string } }).body.name, "x");
      },
    );

    await t.step(
      "should rename free occurrence in systemF-let value and body when binder doesn't match",
      () => {
        const term: TripLangValueType = {
          kind: "systemF-let",
          name: "y",
          value: { kind: "systemF-var", name: "x" },
          body: { kind: "systemF-var", name: "y" },
        };
        const renamed = alphaRenameTermBinder(term, "x", "z");
        assertEquals(renamed.kind, "systemF-let");
        assertEquals((renamed as { name: string }).name, "y");
        assertEquals((renamed as { value: { name: string } }).value.name, "z");
        assertEquals((renamed as { body: { name: string } }).body.name, "y");
      },
    );

    await t.step(
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
        assertEquals(renamed.kind, "systemF-let");
        assertEquals((renamed as { name: string }).name, "y");
        const inner = (renamed as { body: TripLangValueType }).body;
        assertEquals(inner.kind, "systemF-let");
        assertEquals((inner as { name: string }).name, "y");
        assertEquals(
          (inner as { body: { name: string } }).body.name,
          "y",
        );
      },
    );
  });

  await t.step("alphaRenameTypeBinder", async (t) => {
    await t.step("should rename forall binder", () => {
      const term: TripLangValueType = {
        kind: "forall",
        typeVar: "A",
        body: {
          kind: "type-var",
          typeName: "A",
        },
      };
      const renamed = alphaRenameTypeBinder(term, "A", "B");
      assertEquals(renamed.kind, "forall");
      assertEquals((renamed as { typeVar: string }).typeVar, "B");
      assertEquals(
        (renamed as { body: { typeName: string } }).body.typeName,
        "B",
      );
    });

    await t.step("should rename System F type binder", () => {
      const term: TripLangValueType = {
        kind: "systemF-type-abs",
        typeVar: "A",
        body: {
          kind: "systemF-var",
          name: "x",
        },
      };
      const renamed = alphaRenameTypeBinder(term, "A", "B");
      assertEquals(renamed.kind, "systemF-type-abs");
      assertEquals((renamed as { typeVar: string }).typeVar, "B");
      // The body should remain unchanged since it doesn't contain the type variable
      assertEquals((renamed as { body: { name: string } }).body.name, "x");
    });

    await t.step("should not rename if binder name doesn't match", () => {
      const term: TripLangValueType = {
        kind: "forall",
        typeVar: "A",
        body: {
          kind: "type-var",
          typeName: "A",
        },
      };
      const renamed = alphaRenameTypeBinder(term, "B", "C");
      assertEquals(renamed.kind, "forall");
      assertEquals((renamed as { typeVar: string }).typeVar, "A");
      assertEquals(
        (renamed as { body: { typeName: string } }).body.typeName,
        "A",
      );
    });

    await t.step("should rename type variables in match expression", () => {
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
      assertEquals(renamed.kind, "systemF-match");
      assertEquals(
        (renamed as { returnType: { typeName: string } }).returnType.typeName,
        "B",
      );
      // Scrutinee and arms should remain unchanged
      assertEquals(
        (renamed as { scrutinee: { name: string } }).scrutinee.name,
        "x",
      );
      const arm = (renamed as {
        arms: Array<{ params: string[]; body: { name: string } }>;
      }).arms[0];
      assertEquals(arm.params[0], "a");
      assertEquals(arm.body.name, "a");
    });

    await t.step(
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
        assertEquals(renamed.kind, "systemF-match");
        const scrutinee = (renamed as {
          scrutinee: {
            kind: string;
            typeArg: { typeName: string };
          };
        }).scrutinee;
        assertEquals(scrutinee.typeArg.typeName, "B");
        assertEquals(
          (renamed as { returnType: { typeName: string } }).returnType.typeName,
          "B",
        );
      },
    );

    await t.step("should recurse into systemF-let value and body for type binder rename", () => {
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
      assertEquals(renamed.kind, "systemF-let");
      assertEquals((renamed as { name: string }).name, "x");
      const value = (renamed as { value: TripLangValueType }).value;
      assertEquals(value.kind, "systemF-type-app");
      assertEquals(
        (value as { typeArg: { typeName: string } }).typeArg.typeName,
        "B",
      );
    });
  });

  await t.step("substituteHygienic", async (t) => {
    await t.step("should substitute variable without capture", () => {
      const term: TripLangValueType = {
        kind: "lambda-var",
        name: "x",
      };
      const replacement: TripLangValueType = {
        kind: "lambda-var",
        name: "y",
      };
      const result = substituteHygienic(term, "x", replacement);
      assertEquals(result.kind, "lambda-var");
      assertEquals((result as { name: string }).name, "y");
    });

    await t.step("should avoid variable capture in lambda abstraction", () => {
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
      assertEquals(result.kind, "lambda-abs");
      // The binder should be renamed to avoid capture
      const binderName = (result as { name: string }).name;
      assertEquals(binderName !== "x", true);
      assertEquals(
        (result as { body: { name: string } }).body.name,
        binderName,
      );
    });

    await t.step(
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
        assertEquals(result.kind, "systemF-abs");
        // The binder should be renamed to avoid capture
        const binderName = (result as { name: string }).name;
        assertEquals(binderName !== "x", true);
        assertEquals(
          (result as { body: { name: string } }).body.name,
          binderName,
        );
      },
    );

    await t.step("should substitute in nested structures", () => {
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
      assertEquals(result.kind, "non-terminal");
      assertEquals((result as { lft: { name: string } }).lft.name, "z");
      assertEquals((result as { rgt: { name: string } }).rgt.name, "y");
    });

    await t.step("should not substitute bound variables", () => {
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
      assertEquals(result.kind, "lambda-abs");
      assertEquals((result as { name: string }).name, "x");
      assertEquals((result as { body: { name: string } }).body.name, "x");
    });

    await t.step("should handle complex nested substitution", () => {
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
      assertEquals(result.kind, "lambda-abs");
      assertEquals((result as { name: string }).name, "f");
      // The inner f should be substituted, but not the binder
      assertEquals(
        (result as { body: { body: { lft: { name: string } } } }).body.body.lft
          .name,
        "f",
      );
      assertEquals(
        (result as { body: { body: { rgt: { name: string } } } }).body.body.rgt
          .name,
        "x",
      );
    });

    await t.step("should substitute in systemF-let value and body", () => {
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
      assertEquals(resultY.kind, "systemF-let");
      assertEquals((resultY as { name: string }).name, "x");
      assertEquals((resultY as { value: { name: string } }).value.name, "w");
      assertEquals((resultY as { body: { name: string } }).body.name, "z");

      const resultZ = substituteHygienic(term, "z", replacement);
      assertEquals(resultZ.kind, "systemF-let");
      assertEquals((resultZ as { value: { name: string } }).value.name, "y");
      assertEquals((resultZ as { body: { name: string } }).body.name, "w");
    });

    await t.step(
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
        assertEquals(result.kind, "systemF-let");
        const binderName = (result as { name: string }).name;
        assertEquals(binderName !== "x", true);
        assertEquals((result as { value: { name: string } }).value.name, "x");
        assertEquals((result as { body: { name: string } }).body.name, binderName);
      },
    );
  });

  await t.step("substituteTypeHygienic", async (t) => {
    await t.step("should substitute type variable without capture", () => {
      const term: TripLangValueType = {
        kind: "type-var",
        typeName: "A",
      };
      const replacement: TripLangValueType = {
        kind: "type-var",
        typeName: "B",
      };
      const result = substituteTypeHygienic(term, "A", replacement);
      assertEquals(result.kind, "type-var");
      assertEquals((result as { typeName: string }).typeName, "B");
    });

    await t.step("should avoid type variable capture in forall", () => {
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
      assertEquals(result.kind, "forall");
      // The binder should be renamed to avoid capture
      const binderName = (result as { typeVar: string }).typeVar;
      assertEquals(binderName !== "A", true);
      assertEquals(
        (result as { body: { typeName: string } }).body.typeName,
        binderName,
      );
    });

    await t.step(
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
        assertEquals(result.kind, "systemF-type-abs");
        // The binder should remain unchanged since there's no capture
        const binderName = (result as { typeVar: string }).typeVar;
        assertEquals(binderName, "A");
        // The body should remain unchanged since it doesn't contain the type variable
        assertEquals((result as { body: { name: string } }).body.name, "x");
      },
    );

    await t.step("should substitute in nested type structures", () => {
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
      assertEquals(result.kind, "systemF-type-app");
      // The term should remain unchanged since it doesn't contain the type variable
      assertEquals((result as { term: { name: string } }).term.name, "x");
      assertEquals(
        (result as { typeArg: { typeName: string } }).typeArg.typeName,
        "B",
      );
    });

    await t.step("should recurse into systemF-let value and body for type substitution", () => {
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
      assertEquals(result.kind, "systemF-let");
      assertEquals((result as { name: string }).name, "x");
      const value = (result as { value: TripLangValueType }).value;
      assertEquals(value.kind, "systemF-type-app");
      assertEquals(
        (value as { typeArg: { typeName: string } }).typeArg.typeName,
        "B",
      );
      assertEquals((result as { body: { name: string } }).body.name, "x");
    });

    await t.step("should not substitute bound type variables", () => {
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
      assertEquals(result.kind, "forall");
      assertEquals((result as { typeVar: string }).typeVar, "A");
      assertEquals(
        (result as { body: { typeName: string } }).body.typeName,
        "A",
      );
    });

    await t.step("should handle complex nested type substitution", () => {
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
      assertEquals(result.kind, "systemF-abs");
      // The inner A should be substituted, but not the binder
      const typeAnnotation = (result as {
        typeAnnotation: {
          kind: string;
          typeVar: string;
          body: { typeName: string };
        };
      }).typeAnnotation;
      assertEquals(typeAnnotation.kind, "forall");
      const binderName = typeAnnotation.typeVar;
      assertEquals(binderName, "A");
      assertEquals(typeAnnotation.body.typeName, "A");
    });
  });

  await t.step("edge cases", async (t) => {
    await t.step("should handle empty bound set", () => {
      const term: TripLangValueType = {
        kind: "lambda-var",
        name: "x",
      };
      const replacement: TripLangValueType = {
        kind: "lambda-var",
        name: "y",
      };
      const result = substituteHygienic(term, "x", replacement, new Set());
      assertEquals(result.kind, "lambda-var");
      assertEquals((result as { name: string }).name, "y");
    });

    await t.step("should handle non-matching variable names", () => {
      const term: TripLangValueType = {
        kind: "lambda-var",
        name: "x",
      };
      const replacement: TripLangValueType = {
        kind: "lambda-var",
        name: "y",
      };
      const result = substituteHygienic(term, "z", replacement);
      assertEquals(result.kind, "lambda-var");
      assertEquals((result as { name: string }).name, "x");
    });

    await t.step("should handle terminal nodes", () => {
      const term: TripLangValueType = {
        kind: "terminal",
        sym: SKITerminalSymbol.S,
      };
      const replacement: TripLangValueType = {
        kind: "lambda-var",
        name: "x",
      };
      const result = substituteHygienic(term, "x", replacement);
      assertEquals(result.kind, "terminal");
    });

    await t.step("should handle type variables in term substitution", () => {
      const term: TripLangValueType = {
        kind: "type-var",
        typeName: "A",
      };
      const replacement: TripLangValueType = {
        kind: "lambda-var",
        name: "x",
      };
      const result = substituteHygienic(term, "x", replacement);
      assertEquals(result.kind, "type-var");
      assertEquals((result as { typeName: string }).typeName, "A");
    });

    await t.step("should substitute in match expression", () => {
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
      assertEquals(result.kind, "systemF-match");
      assertEquals(
        (result as { scrutinee: { name: string } }).scrutinee.name,
        "y",
      );
      // The x in the match arm body should be substituted
      assertEquals(
        (result as { arms: Array<{ body: { name: string } }> }).arms[0].body
          .name,
        "y",
      );
    });

    await t.step(
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
        assertEquals(result.kind, "systemF-match");
        assertEquals(
          (result as { scrutinee: { name: string } }).scrutinee.name,
          "x",
        );
        // The match arm parameter 'x' should be renamed to avoid capture
        const arm = (result as {
          arms: Array<{ params: string[]; body: { name: string } }>;
        }).arms[0];
        assertEquals(arm.params[0] !== "x", true); // Should be renamed
        assertEquals(arm.body.name, arm.params[0]); // Body should reference renamed param
      },
    );

    await t.step(
      "should substitute in match scrutinee and return type",
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
        assertEquals(result.kind, "systemF-match");
        assertEquals(
          (result as { scrutinee: { name: string } }).scrutinee.name,
          "z",
        );
        // Return type should remain unchanged since it's a type-var, not a term variable
        const returnType = (result as {
          returnType: { typeName: string };
        }).returnType;
        assertEquals(returnType.typeName, "T");
      },
    );

    await t.step(
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
        assertEquals(result.kind, "systemF-match");
        const arms = (result as {
          arms: Array<{ params: string[]; body: { name: string } }>;
        }).arms;
        assertEquals(arms[0].body.name, "x"); // Should remain unchanged
        assertEquals(arms[1].body.name, "z"); // Should be substituted
      },
    );

    await t.step(
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
        assertEquals(result.kind, "systemF-match");
        const arm = (result as {
          arms: Array<
            {
              params: string[];
              body: { lft: { name: string }; rgt: { name: string } };
            }
          >;
        }).arms[0];
        // Both parameters should be renamed
        assertEquals(arm.params[0] !== "x", true);
        assertEquals(arm.params[1] !== "y", true);
        assertEquals(arm.body.lft.name, arm.params[0]);
        assertEquals(arm.body.rgt.name, arm.params[1]);
      },
    );
  });

  await t.step("substituteTypeHygienic - systemF-match", async (t) => {
    await t.step("should substitute type variables in match expression", () => {
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
      assertEquals(result.kind, "systemF-match");
      assertEquals(
        (result as { returnType: { typeName: string } }).returnType.typeName,
        "B",
      );
    });

    await t.step(
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
        assertEquals(result.kind, "systemF-match");
        const scrutinee = (result as {
          scrutinee: {
            kind: string;
            typeArg: { typeName: string };
          };
        }).scrutinee;
        assertEquals(scrutinee.typeArg.typeName, "B");
        assertEquals(
          (result as { returnType: { typeName: string } }).returnType.typeName,
          "B",
        );
        const arm = (result as {
          arms: Array<{
            body: {
              kind: string;
              typeArg: { typeName: string };
            };
          }>;
        }).arms[0];
        assertEquals(arm.body.typeArg.typeName, "B");
      },
    );

    await t.step(
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
        assertEquals(result.kind, "systemF-type-abs");
        const match = (result as {
          body: {
            kind: string;
            returnType: { typeName: string };
          };
        }).body;
        assertEquals(match.kind, "systemF-match");
        // The A in returnType should remain A because it's bound by the outer type abstraction
        assertEquals(match.returnType.typeName, "A");
      },
    );
  });
});
