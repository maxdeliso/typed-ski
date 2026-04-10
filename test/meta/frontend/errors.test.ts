import { describe, it } from "../../util/test_shim.ts";
import assert from "node:assert/strict";
import { CompilationError } from "../../../lib/meta/frontend/errors.ts";

describe("CompilationError", () => {
  it("should format basic error message", () => {
    const error = new CompilationError("Base message", "parse");
    assert.strictEqual(error.message, "Base message");
    assert.strictEqual(error.stage, "parse");
    assert.strictEqual(error.name, "CompilationError");
  });

  it("should format error with primitive cause", () => {
    const error = new CompilationError("Base message", "index", "Simple cause");
    assert.strictEqual(error.message, `Base message\nCause: "Simple cause"`);
  });

  it("should format error with bigint cause", () => {
    const error = new CompilationError("Base message", "index", 123n);
    assert.strictEqual(error.message, `Base message\nCause: "123n"`);
  });

  it("should format error with term in cause", () => {
    const error = new CompilationError("Base message", "elaborate", {
      term: { kind: "systemF-abs", name: "x" },
    });
    assert.strictEqual(error.message, `Base message\nTerm: systemF-abs x`);
  });

  it("should format error with kind-only term in cause", () => {
    const error = new CompilationError("Base message", "elaborate", {
      term: { kind: "systemF-app" },
    });
    assert.strictEqual(error.message, `Base message\nTerm: systemF-app`);
  });

  it("should format error with complex term in cause", () => {
    const error = new CompilationError("Base message", "elaborate", {
      term: { other: "data" },
    });
    assert.strictEqual(error.message, `Base message\nTerm: {"other":"data"}`);
  });

  it("should format error with nested error in cause", () => {
    const error = new CompilationError("Base message", "typecheck", {
      error: "Inner error details",
    });
    assert.strictEqual(
      error.message,
      `Base message\nError: Inner error details`,
    );
  });

  it("should format error with unresolved references", () => {
    const error = new CompilationError("Base message", "resolve", {
      unresolvedTerms: ["a", "b"],
      unresolvedTypes: ["T"],
    });
    assert.strictEqual(
      error.message,
      `Base message\nUnresolved references:\nTerms: ["a","b"]\nTypes: ["T"]`,
    );
  });

  it("should format error with only unresolved terms", () => {
    const error = new CompilationError("Base message", "resolve", {
      unresolvedTerms: ["a"],
    });
    assert.strictEqual(
      error.message,
      `Base message\nUnresolved references:\nTerms: ["a"]`,
    );
  });

  it("should format error with only unresolved types", () => {
    const error = new CompilationError("Base message", "resolve", {
      unresolvedTypes: ["T"],
    });
    assert.strictEqual(
      error.message,
      `Base message\nUnresolved references:\nTypes: ["T"]`,
    );
  });

  it("should handle null cause", () => {
    const error = new CompilationError("Base message", "parse", null);
    assert.strictEqual(error.message, `Base message\nCause: null`);
  });

  it("should handle undefined cause gracefully", () => {
    const error = new CompilationError("Base message", "parse", undefined);
    assert.strictEqual(error.message, "Base message");
  });

  it("should handle circular references in stringify (hypothetical)", () => {
    const circular: Record<string, unknown> = { kind: "circ" };
    circular.self = circular;
    const error = new CompilationError("Base message", "index", {
      term: circular,
    });
    // formatTermForError uses JSON.stringify which will fail on circular
    // and then fallback to String(term)
    assert.ok(error.message.includes(`Base message\nTerm: `));
  });
});
