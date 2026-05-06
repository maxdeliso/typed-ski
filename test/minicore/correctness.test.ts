import { describe, it } from "../util/test_shim.ts";
import assert from "node:assert/strict";
import {
  compileMiniCoreModules,
  evaluateMiniCore,
  valueToNat,
} from "../../lib/minicore/index.ts";
import { loadTripSourceFile } from "../../lib/tripSourceLoader.ts";

const PRELUDE_URL = new URL("../../lib/prelude.trip", import.meta.url);
const NAT_URL = new URL("../../lib/nat.trip", import.meta.url);
const BIN_URL = new URL("../../lib/bin.trip", import.meta.url);
const INPUT_DIR = new URL("../inputs/minicore/", import.meta.url);

async function loadInput(name: string) {
  return await loadTripSourceFile(new URL(name, INPUT_DIR));
}

async function getBaseModules() {
  return [
    { name: "Prelude", source: await loadTripSourceFile(PRELUDE_URL) },
    { name: "Nat", source: await loadTripSourceFile(NAT_URL) },
    { name: "Bin", source: await loadTripSourceFile(BIN_URL) },
  ];
}

describe("MiniCore Correctness", () => {
  it("handles constructor identity correctly (Issue 1)", async () => {
    const modules = [
      ...(await getBaseModules()),
      { name: "A", source: await loadInput("A.trip") },
      { name: "B", source: await loadInput("B.trip") },
    ];

    const program = compileMiniCoreModules(modules, "A");
    const result = evaluateMiniCore(program);

    const aBar = program.symbolsByName.get("A.Foo.Bar");
    const bBar = program.symbolsByName.get("B.Foo.Bar");

    assert.ok(aBar !== undefined, "A.Foo.Bar should exist");
    assert.ok(bBar !== undefined, "B.Foo.Bar should exist");
    assert.notStrictEqual(
      aBar,
      bBar,
      "A.Foo.Bar and B.Foo.Bar should have different IDs",
    );
    assert.strictEqual(
      (result.value as any).tag,
      aBar,
      "Result should be A.Foo.Bar",
    );
  });

  it("handles ambiguous constructors (Issue 1)", async () => {
    const modules = [
      ...(await getBaseModules()),
      {
        name: "Ambiguous",
        source: `
        module Ambiguous
        export main
        data K = Bar
        data J = Bar
        poly main = Bar
      `,
      },
    ];

    assert.throws(
      () => compileMiniCoreModules(modules, "Ambiguous"),
      /Ambiguous constructor Bar/,
    );
  });

  it("handles let scoping correctly (Issue 2)", async () => {
    const modules = [
      ...(await getBaseModules()),
      { name: "LetScoping", source: await loadInput("LetScoping.trip") },
    ];

    const program = compileMiniCoreModules(modules, "LetScoping");
    const result = evaluateMiniCore(program);
    assert.strictEqual(valueToNat(result.value), 2n);
  });

  it("rejects unused higher-order argument after shadowing (Issue 3)", async () => {
    const modules = [
      ...(await getBaseModules()),
      { name: "Shadowing", source: await loadInput("Shadowing.trip") },
    ];

    // Shadowing.inner param g is NOT specialized because it's shadowed.
    // Thus inner succ zero will fail because succ is a bare function of arity 1.
    // This confirms that shadowed names are correctly excluded from top-level
    // term resolution and callable parameter analysis.
    assert.throws(
      () => compileMiniCoreModules(modules, "Shadowing"),
      /Nat.succ expects 1 argument\(s\), got 0/,
    );
  });

  it("handles and/or short-circuiting (Issue 7)", async () => {
    const modules = [
      ...(await getBaseModules()),
      { name: "ShortCircuit", source: await loadInput("ShortCircuit.trip") },
    ];

    const program = compileMiniCoreModules(modules, "ShortCircuit");
    const result = evaluateMiniCore(program);
    const trueConstructorId = program.symbolsByName.get("Prelude.true");
    assert.ok(trueConstructorId !== undefined, "Missing Prelude.true constructor");
    assert.strictEqual(result.value.kind, "con");
    assert.strictEqual(result.value.tag, trueConstructorId);
  });

  it("provides detailed specialization failure diagnostics (Issue 5)", async () => {
    const modules = [
      ...(await getBaseModules()),
      {
        name: "SpecializationFailure",
        source: await loadInput("SpecializationFailure.trip"),
      },
    ];

    assert.throws(
      () => compileMiniCoreModules(modules, "SpecializationFailure"),
      /MiniCore cannot specialize dynamic function argument x for parameter f of SpecializationFailure.high/,
    );
  });
});
