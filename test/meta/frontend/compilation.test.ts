import {
  assertEquals,
  assertThrows,
} from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  CompilationError,
  compile,
} from "../../../lib/meta/frontend/compilation.ts";

Deno.test("Module validation", async (t) => {
  await t.step(
    "should accept program with exactly one module definition",
    () => {
      const input = `
module MyModule
poly id = Λa.λx:a.x
    `;

      const result = compile(input);
      console.log("Compilation result:", result);
      assertEquals(result.program.kind, "program");
    },
  );

  await t.step("should reject program with no module definition", () => {
    const input = `
poly id = Λa.λx:a.x
    `;

    assertThrows(
      () => compile(input),
      CompilationError,
      "No module definition found. Each program must have exactly one module definition.",
    );
  });

  await t.step("should reject program with multiple module definitions", () => {
    const input = `
module MyModule
module AnotherModule
poly id = Λa.λx:a.x
    `;

    assertThrows(
      () => compile(input),
      CompilationError,
      "Multiple module definitions found: MyModule, AnotherModule. Each program must have exactly one module definition.",
    );
  });

  await t.step(
    "should accept program with module, imports, and exports",
    () => {
      const input = `
module MyModule
import Foo bar
export Baz
poly id = Λa.λx:a.x
    `;

      // Should not throw
      const result = compile(input);
      assertEquals(result.program.kind, "program");
    },
  );

  await t.step("should allow unresolved imported symbol", () => {
    const input = `
module MyModule
import Foo bar
poly usesFoo = Foo
    `;
    // Should not throw, since Foo is imported
    const result = compile(input);
    assertEquals(result.program.kind, "program");
  });

  await t.step("should fail on unresolved absent symbol", () => {
    const input = `
module MyModule
poly usesBar = Bar
    `;
    assertThrows(
      () => compile(input),
      CompilationError,
      "Unresolved external term reference: Bar",
    );
  });
});
