import { assertEquals, assertThrows } from "std/assert";
import { expect } from "chai";

import type { ProgramSpace } from "../../lib/linker/moduleLinker.ts";
import {
  createProgramSpace,
  findMainFunction,
  loadModule,
  resolveCrossModuleDependencies,
} from "../../lib/linker/moduleLinker.ts";
import { SKITerminalSymbol } from "../../lib/ski/terminal.ts";

Deno.test("moduleLinker edge cases (coverage)", async (t) => {
  await t.step(
    "createProgramSpace: export listed but definition missing",
    () => {
      // This hits inferImportKind()'s failure path via buildEnvironments():
      // origin.exports has the symbol, but it is neither a term nor a type in the global indices.
      const origin = {
        module: "Origin",
        exports: ["ghost"],
        imports: [],
        definitions: {
          // intentionally empty / missing `ghost`
        },
      };

      const consumer = {
        module: "Consumer",
        exports: ["main"],
        imports: [{ from: "Origin", name: "ghost" }],
        definitions: {
          main: {
            kind: "combinator" as const,
            name: "main",
            term: { kind: "terminal" as const, sym: SKITerminalSymbol.I },
          },
        },
      };

      const loaded = [
        loadModule(origin, "Origin"),
        loadModule(consumer, "Consumer"),
      ];

      assertThrows(
        () => createProgramSpace(loaded),
        Error,
        "No symbol 'Origin.ghost' to import",
      );
    },
  );

  await t.step(
    "resolveCrossModuleDependencies: getModuleInfo missing module",
    () => {
      // Create a valid program space, then inject a bogus qualified name into the
      // global terms map so resolution tries to look up a missing module.
      const ok = {
        module: "OK",
        exports: ["main"],
        imports: [],
        definitions: {
          main: {
            kind: "combinator" as const,
            name: "main",
            term: { kind: "terminal" as const, sym: SKITerminalSymbol.I },
          },
        },
      };

      const ps = createProgramSpace([loadModule(ok, "OK")]) as ProgramSpace & {
        terms: Map<string, unknown>;
      };

      ps.terms.set("MissingMod.x", {
        kind: "combinator",
        name: "x",
        term: { kind: "terminal", sym: SKITerminalSymbol.K },
      });

      assertThrows(
        () => resolveCrossModuleDependencies(ps, false),
        Error,
        "Module 'MissingMod' not found for qualified name 'MissingMod.x'",
      );
    },
  );

  await t.step("findMainFunction: exported main is a type (error)", () => {
    const mod = {
      module: "TypeMain",
      exports: ["main"],
      imports: [],
      definitions: {
        main: {
          kind: "type" as const,
          name: "main",
          type: { kind: "type-var" as const, typeName: "X" },
        },
      },
    };
    const ps = createProgramSpace([loadModule(mod, "TypeMain")]);
    assertThrows(
      () => findMainFunction(ps),
      Error,
      "Exported 'main' is a type",
    );
  });

  await t.step(
    "findMainFunction: multiple candidates when bypassing export validation",
    () => {
      // validateExports prevents this in linkModules(), so call findMainFunction directly
      // with a constructed program space to exercise the error branch.
      const fake: ProgramSpace = {
        modules: new Map([
          [
            "A",
            {
              name: "A",
              object: {} as never,
              defs: new Map([
                ["main", {
                  kind: "combinator",
                  name: "main",
                  term: { kind: "terminal", sym: SKITerminalSymbol.I },
                }],
              ]),
              exports: new Set(["main"]),
              imports: [],
            },
          ],
          [
            "B",
            {
              name: "B",
              object: {} as never,
              defs: new Map([
                ["main", {
                  kind: "combinator",
                  name: "main",
                  term: { kind: "terminal", sym: SKITerminalSymbol.K },
                }],
              ]),
              exports: new Set(["main"]),
              imports: [],
            },
          ],
        ]),
        terms: new Map(),
        types: new Map(),
        termEnv: new Map(),
        typeEnv: new Map(),
      };

      let message: string | null = null;
      try {
        findMainFunction(fake);
        expect.fail("expected findMainFunction to throw");
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).to.include("Multiple 'main' functions found");
    },
  );

  await t.step(
    "term resolution: imported ref present in env but missing in global index",
    () => {
      // This drives the 'pendingRefs' path so replacements.size=0 and we converge with
      // "no substitutions available" (without throwing).
      const provider = {
        module: "Provider",
        exports: ["x"],
        imports: [],
        definitions: {
          x: {
            kind: "combinator" as const,
            name: "x",
            term: { kind: "terminal" as const, sym: SKITerminalSymbol.I },
          },
        },
      };

      const consumer = {
        module: "Consumer",
        exports: ["main"],
        imports: [{ from: "Provider", name: "x" }],
        definitions: {
          // This references the imported name `x`, but we will delete Provider.x from ps.terms
          // to simulate a missing global index entry during resolution.
          main: {
            kind: "poly" as const,
            name: "main",
            term: { kind: "systemF-var" as const, name: "x" },
          },
        },
      };

      const ps = createProgramSpace([
        loadModule(provider, "Provider"),
        loadModule(consumer, "Consumer"),
      ]);

      // Remove the global term entry so resolution cannot fetch the imported term.
      ps.terms.delete("Provider.x");

      const resolved = resolveCrossModuleDependencies(ps, false);
      // It should not crash; it will keep `x` unresolved.
      const main = resolved.modules.get("Consumer")?.defs.get("main") as
        | undefined
        | { kind: string; term: { kind: string; name: string } };
      assertEquals(main?.kind, "untyped"); // pre-lowered
      assertEquals(main?.term.kind, "lambda-var");
      assertEquals(main?.term.name, "x");
    },
  );
});
