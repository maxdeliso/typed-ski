import { describe, it } from "../../util/test_shim.ts";
import assert from "node:assert/strict";

import { externalReferences } from "../../../lib/meta/frontend/externalReferences.ts";
import type { TripLangValueType } from "../../../lib/meta/trip.ts";
import { SKITerminalSymbol } from "../../../lib/ski/terminal.ts";
import { makeNatLiteralIdentifier } from "../../../lib/consts/natNames.ts";

describe("externalReferences edge cases (coverage)", () => {
  it("ignores nat literal identifiers in systemF-var", () => {
    const lit = makeNatLiteralIdentifier(42n);
    const term: TripLangValueType = { kind: "systemF-var", name: lit };

    const [termRefs, typeRefs] = externalReferences(term);
    assert.deepStrictEqual(Array.from(termRefs.keys()), []);
    assert.deepStrictEqual(Array.from(typeRefs.keys()), []);
  });

  it("tracks bindings correctly for systemF-let", () => {
    // let x = y in x  -> external refs: y only
    const term: TripLangValueType = {
      kind: "systemF-let",
      name: "x",
      value: { kind: "systemF-var", name: "y" },
      body: { kind: "systemF-var", name: "x" },
    };
    const [termRefs, typeRefs] = externalReferences(term);
    assert.deepStrictEqual(Array.from(termRefs.keys()).sort(), ["y"]);
    assert.deepStrictEqual(Array.from(typeRefs.keys()), []);
  });

  it("collects refs from typed-lambda-abstraction (ty + body)", () => {
    const term: TripLangValueType = {
      kind: "typed-lambda-abstraction",
      varName: "x",
      ty: { kind: "type-var", typeName: "A" },
      body: {
        kind: "non-terminal",
        lft: { kind: "lambda-var", name: "x" }, // bound
        rgt: { kind: "lambda-var", name: "f" }, // free
      },
    };

    const [termRefs, typeRefs] = externalReferences(term);
    assert.deepStrictEqual(Array.from(termRefs.keys()).sort(), ["f"]);
    assert.deepStrictEqual(Array.from(typeRefs.keys()).sort(), ["A"]);
  });

  it("collects refs inside BaseType type-app and forall", () => {
    const ty: TripLangValueType = {
      kind: "forall",
      typeVar: "A",
      body: {
        kind: "type-app",
        fn: { kind: "type-var", typeName: "List" },
        arg: { kind: "type-var", typeName: "A" }, // bound by forall
      },
    };

    const [_termRefs, typeRefs] = externalReferences(ty);
    assert.deepStrictEqual(Array.from(typeRefs.keys()).sort(), ["List"]);
  });

  it("ignores SKI terminal nodes", () => {
    const ski: TripLangValueType = {
      kind: "terminal",
      sym: SKITerminalSymbol.S,
    };
    const [termRefs, typeRefs] = externalReferences(ski);
    assert.deepStrictEqual(Array.from(termRefs.keys()), []);
    assert.deepStrictEqual(Array.from(typeRefs.keys()), []);
  });

  it("memoizes results (same tuple identity on repeated calls)", () => {
    const term: TripLangValueType = {
      kind: "non-terminal",
      lft: { kind: "lambda-var", name: "x" },
      rgt: { kind: "lambda-var", name: "y" },
    };
    const r1 = externalReferences(term);
    const r2 = externalReferences(term);
    assert.strictEqual(r1, r2);
    // and the maps themselves should be referentially identical
    assert.strictEqual(r1[0], r2[0]);
    assert.strictEqual(r1[1], r2[1]);
  });
});
