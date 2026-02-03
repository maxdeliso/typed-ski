import { assertEquals, assertThrows } from "std/assert";
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
poly id = #a=>\\x:a=>x
    `;

      const result = compile(input);
      assertEquals(result.program.kind, "program");
      assertEquals(result.types.get("id")?.kind, "forall");
    },
  );

  await t.step("should reject program with no module definition", () => {
    const input = `
poly id = #a=>\\x:a=>x
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
poly id = #a=>\\x:a=>x
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
poly id = #a=>\\x:a=>x
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
poly usesBar = bar
    `;
    // Should not throw, since bar is imported
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

  await t.step("should fail on duplicate match arm", () => {
    const input = `
module MyModule
data Bool = False | True
poly test = match True [Bool] { | True => False | True => True }
    `;
    assertThrows(
      () => compile(input),
      CompilationError,
      "Duplicate match arm for constructor 'True'",
    );
  });
});
