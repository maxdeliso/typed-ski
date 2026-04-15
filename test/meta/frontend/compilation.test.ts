import { describe, it } from "../../util/test_shim.ts";
import assert from "node:assert/strict";
import { compile } from "../../../lib/meta/frontend/compilation.ts";
import { CompilationError } from "../../../lib/meta/frontend/errors.ts";

describe("Module validation", () => {
  it("should accept program with exactly one module definition", () => {
    const input = `
module MyModule
poly id = #a=>\\x:a=>x
    `;

    const result = compile(input);
    assert.deepStrictEqual(result.program.kind, "program");
    assert.deepStrictEqual(result.types.get("id")?.kind, "forall");
  });

  it("should reject program with no module definition", () => {
    const input = `
poly id = #a=>\\x:a=>x
    `;

    assert.throws(
      () => compile(input),
      CompilationError,
      "No module definition found. Each program must have exactly one module definition.",
    );
  });

  it("should reject program with multiple module definitions", () => {
    const input = `
module MyModule
module AnotherModule
poly id = #a=>\\x:a=>x
    `;

    assert.throws(
      () => compile(input),
      CompilationError,
      "Multiple module definitions found: MyModule, AnotherModule. Each program must have exactly one module definition.",
    );
  });

  it("should accept program with module, imports, and exports", () => {
    const input = `
module MyModule
import Foo bar
export Baz
poly id = #a=>\\x:a=>x
    `;

    // Should not throw
    const result = compile(input);
    assert.deepStrictEqual(result.program.kind, "program");
  });

  it("should allow unresolved imported symbol", () => {
    const input = `
module MyModule
import Foo bar
poly usesBar = bar
    `;
    // Should not throw, since bar is imported
    const result = compile(input);
    assert.deepStrictEqual(result.program.kind, "program");
  });

  it("should fail on unresolved absent symbol", () => {
    const input = `
module MyModule
poly usesBar = Bar
    `;
    assert.throws(
      () => compile(input),
      CompilationError,
      "Unresolved external term reference: Bar",
    );
  });

  it("should fail on duplicate match arm", () => {
    const input = `
module MyModule
data Bool = False | True
poly test = match True [Bool] { | True => False | True => True }
    `;
    assert.throws(
      () => compile(input),
      CompilationError,
      "Duplicate match arm for constructor 'True'",
    );
  });
});
