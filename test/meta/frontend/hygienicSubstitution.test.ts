/**
 * Tests for hygienic substitution functions
 *
 * This module tests the hygienic substitution algorithms that avoid variable
 * capture by tracking bound variables and performing alpha-renaming when necessary.
 */

import { assertEquals } from "@std/assert";
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
  });
});
