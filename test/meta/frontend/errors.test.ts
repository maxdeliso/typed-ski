import { expect } from "chai";
import { CompilationError } from "../../../lib/meta/frontend/errors.ts";

Deno.test("CompilationError", async (t) => {
  await t.step("should format basic error message", () => {
    const error = new CompilationError("Base message", "parse");
    expect(error.message).to.equal("Base message");
    expect(error.stage).to.equal("parse");
    expect(error.name).to.equal("CompilationError");
  });

  await t.step("should format error with primitive cause", () => {
    const error = new CompilationError("Base message", "index", "Simple cause");
    expect(error.message).to.equal(`Base message\nCause: "Simple cause"`);
  });

  await t.step("should format error with bigint cause", () => {
    const error = new CompilationError("Base message", "index", 123n);
    expect(error.message).to.equal(`Base message\nCause: "123n"`);
  });

  await t.step("should format error with term in cause", () => {
    const error = new CompilationError("Base message", "elaborate", {
      term: { kind: "systemF-abs", name: "x" },
    });
    expect(error.message).to.equal(`Base message\nTerm: systemF-abs x`);
  });

  await t.step("should format error with kind-only term in cause", () => {
    const error = new CompilationError("Base message", "elaborate", {
      term: { kind: "systemF-app" },
    });
    expect(error.message).to.equal(`Base message\nTerm: systemF-app`);
  });

  await t.step("should format error with complex term in cause", () => {
    const error = new CompilationError("Base message", "elaborate", {
      term: { other: "data" },
    });
    expect(error.message).to.equal(`Base message\nTerm: {"other":"data"}`);
  });

  await t.step("should format error with nested error in cause", () => {
    const error = new CompilationError("Base message", "typecheck", {
      error: "Inner error details",
    });
    expect(error.message).to.equal(`Base message\nError: Inner error details`);
  });

  await t.step("should format error with unresolved references", () => {
    const error = new CompilationError("Base message", "resolve", {
      unresolvedTerms: ["a", "b"],
      unresolvedTypes: ["T"],
    });
    expect(error.message).to.equal(
      `Base message\nUnresolved references:\nTerms: ["a","b"]\nTypes: ["T"]`,
    );
  });

  await t.step("should format error with only unresolved terms", () => {
    const error = new CompilationError("Base message", "resolve", {
      unresolvedTerms: ["a"],
    });
    expect(error.message).to.equal(
      `Base message\nUnresolved references:\nTerms: ["a"]`,
    );
  });

  await t.step("should format error with only unresolved types", () => {
    const error = new CompilationError("Base message", "resolve", {
      unresolvedTypes: ["T"],
    });
    expect(error.message).to.equal(
      `Base message\nUnresolved references:\nTypes: ["T"]`,
    );
  });

  await t.step("should handle null cause", () => {
    const error = new CompilationError("Base message", "parse", null);
    expect(error.message).to.equal(`Base message\nCause: null`);
  });

  await t.step("should handle undefined cause gracefully", () => {
    const error = new CompilationError("Base message", "parse", undefined);
    expect(error.message).to.equal("Base message");
  });

  await t.step(
    "should handle circular references in stringify (hypothetical)",
    () => {
      const circular: Record<string, unknown> = { kind: "circ" };
      circular.self = circular;
      const error = new CompilationError("Base message", "index", {
        term: circular,
      });
      // formatTermForError uses JSON.stringify which will fail on circular
      // and then fallback to String(term)
      expect(error.message).to.contain(`Base message\nTerm: `);
    },
  );
});
