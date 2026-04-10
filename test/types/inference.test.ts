import { describe, it } from "../util/test_shim.ts";
import assert from "node:assert/strict";

import { untypedAbs, mkVar, untypedApp } from "../../lib/terms/lambda.ts";

import { inferType, substituteType, unify } from "../../lib/types/inference.ts";
import {
  arrow,
  mkTypeVariable,
  typeApp,
  typesLitEq,
} from "../../lib/types/types.ts";

describe("Type inference utilities", () => {
  describe("substituteType", () => {
    it("replaces a variable with another type", () => {
      const a = mkTypeVariable("a");
      const b = mkTypeVariable("b");
      const c = mkTypeVariable("c");

      const r1 = substituteType(a, a, b);
      assert.strictEqual(typesLitEq(r1, b), true);

      const r2 = substituteType(c, a, b);
      assert.strictEqual(typesLitEq(r2, c), true);

      const r3 = substituteType(arrow(a, c), a, b);
      assert.strictEqual(typesLitEq(r3, arrow(b, c)), true);
    });

    it("handles substitutions in complex arrows", () => {
      const a = mkTypeVariable("a");
      const b = mkTypeVariable("b");
      const c = mkTypeVariable("c");

      const complex = arrow(arrow(a, b), c);
      const out = substituteType(complex, a, c);

      assert.strictEqual(typesLitEq(out, arrow(arrow(c, b), c)), true);
    });

    it("handles deeply nested substitutions", () => {
      const a = mkTypeVariable("a");
      const b = mkTypeVariable("b");

      const nested = arrow(arrow(a, a), arrow(a, a));
      const out = substituteType(nested, a, b);

      assert.strictEqual(
        typesLitEq(out, arrow(arrow(b, b), arrow(b, b))),
        true,
      );
    });

    it("handles substitutions in type applications", () => {
      const a = mkTypeVariable("a");
      const b = mkTypeVariable("b");
      const listA = typeApp(mkTypeVariable("List"), a);
      const out = substituteType(listA, a, b);

      assert.strictEqual(
        typesLitEq(out, typeApp(mkTypeVariable("List"), b)),
        true,
      );
    });

    it("substitutes in both fn and arg of nested type-app", () => {
      const a = mkTypeVariable("a");
      const b = mkTypeVariable("b");
      const resultAB = typeApp(typeApp(mkTypeVariable("Result"), a), b);
      const out = substituteType(resultAB, a, mkTypeVariable("Err"));
      const expected = typeApp(
        typeApp(mkTypeVariable("Result"), mkTypeVariable("Err")),
        b,
      );
      assert.strictEqual(typesLitEq(out, expected), true);

      const out2 = substituteType(resultAB, b, mkTypeVariable("Ok"));
      const expected2 = typeApp(
        typeApp(mkTypeVariable("Result"), a),
        mkTypeVariable("Ok"),
      );
      assert.strictEqual(typesLitEq(out2, expected2), true);
    });
  });

  describe("unify", () => {
    it("unifies type applications by components", () => {
      const a = mkTypeVariable("A");
      const b = mkTypeVariable("B");
      const c = mkTypeVariable("C");
      const ctx = unify(
        typeApp(a, b),
        typeApp(a, c),
        new Map<string, ReturnType<typeof mkTypeVariable>>(),
      );

      const boundB = ctx.get("B");
      const boundC = ctx.get("C");
      const ok =
        (boundB !== undefined && typesLitEq(boundB, c)) ||
        (boundC !== undefined && typesLitEq(boundC, b));
      assert.strictEqual(ok, true);
    });

    it("rejects occurs check in type applications", () => {
      const a = mkTypeVariable("A");
      const b = mkTypeVariable("B");
      assert.throws(
        () => unify(a, typeApp(a, b), new Map()),
        /occurs check failed/,
      );
    });

    it("unifies nested type-apps by components", () => {
      const resultAB = typeApp(
        typeApp(mkTypeVariable("Result"), mkTypeVariable("E1")),
        mkTypeVariable("T1"),
      );
      const resultCD = typeApp(
        typeApp(mkTypeVariable("Result"), mkTypeVariable("E2")),
        mkTypeVariable("T2"),
      );
      const ctx = unify(resultAB, resultCD, new Map());

      // Unify binds LHS vars: E1 -> E2, T1 -> T2
      const e1 = ctx.get("E1");
      const t1 = ctx.get("T1");
      assert.ok(e1 !== undefined && typesLitEq(e1, mkTypeVariable("E2")));
      assert.strictEqual(
        t1 !== undefined && typesLitEq(t1, mkTypeVariable("T2")),
        true,
      );
    });

    it("occurs check in type-app arg is rejected", () => {
      const a = mkTypeVariable("X");
      const nested = typeApp(
        mkTypeVariable("F"),
        typeApp(a, mkTypeVariable("Y")),
      );
      assert.throws(() => unify(a, nested, new Map()), /occurs check failed/);
    });
  });

  describe("inferType", () => {
    it("infers type for a simple identity function", () => {
      const id = untypedAbs("x", mkVar("x"));
      const [, ty] = inferType(id);

      assert.strictEqual(ty.kind, "non-terminal");
    });

    it("infers arrow type with matching ends", () => {
      const id = untypedAbs("x", mkVar("x"));
      const [, ty] = inferType(id);

      if (
        ty.kind === "non-terminal" &&
        ty.lft.kind === "type-var" &&
        ty.rgt.kind === "type-var"
      ) {
        assert.strictEqual(ty.lft.typeName, ty.rgt.typeName);
      }
    });

    it("infers type of the application combinator", () => {
      const appComb = untypedAbs(
        "f",
        untypedAbs("x", untypedApp(mkVar("f"), mkVar("x"))),
      );
      const [, ty] = inferType(appComb);

      assert.strictEqual(ty.kind, "non-terminal");
    });

    it("handles a more complex term (K combinator)", () => {
      const kComb = untypedAbs("x", untypedAbs("y", mkVar("x")));
      const [, ty] = inferType(kComb);

      assert.strictEqual(ty.kind, "non-terminal");
    });
  });
});
