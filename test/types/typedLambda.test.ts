import { describe, it } from "../util/test_shim.ts";
import assert from "node:assert/strict";

import { mkVar } from "../../lib/terms/lambda.ts";
import {
  addBinding,
  emptyContext,
  typecheckTypedLambda,
} from "../../lib/types/typedLambda.ts";
import { createTypedApp, mkTypedAbs } from "../util/ast.ts";
import {
  arrow,
  arrows,
  mkTypeVariable,
  typesLitEq,
} from "../../lib/types/types.ts";

describe("typed λ-calculus type-checker", () => {
  describe("type-checking errors", () => {
    it("free variable triggers error", () => {
      assert.throws(
        () => typecheckTypedLambda(mkVar("x")),
        /unbound variable x/,
      );
    });

    it("duplicate binding in context", () => {
      let ctx = emptyContext();
      ctx = addBinding(ctx, "x", mkTypeVariable("a"));
      assert.throws(
        () => addBinding(ctx, "x", mkTypeVariable("b")),
        /variable x already bound in context/,
      );
    });
  });

  describe("successful type-checks", () => {
    it("I combinator (λx:a.x)", () => {
      const typedI = mkTypedAbs("x", mkTypeVariable("a"), mkVar("x"));
      const ty = typecheckTypedLambda(typedI);
      assert.strictEqual(
        typesLitEq(ty, arrow(mkTypeVariable("a"), mkTypeVariable("a"))),
        true,
      );
    });

    it("K combinator", () => {
      const typedK = mkTypedAbs(
        "x",
        mkTypeVariable("a"),
        mkTypedAbs("y", mkTypeVariable("b"), mkVar("x")),
      );
      const ty = typecheckTypedLambda(typedK);
      const expected = arrows(
        mkTypeVariable("a"),
        mkTypeVariable("b"),
        mkTypeVariable("a"),
      );
      assert.strictEqual(typesLitEq(ty, expected), true);
    });

    it("S combinator", () => {
      const typedS = mkTypedAbs(
        "x",
        arrows(mkTypeVariable("a"), mkTypeVariable("b"), mkTypeVariable("c")),
        mkTypedAbs(
          "y",
          arrow(mkTypeVariable("a"), mkTypeVariable("b")),
          mkTypedAbs(
            "z",
            mkTypeVariable("a"),
            createTypedApp(
              createTypedApp(mkVar("x"), mkVar("z")),
              createTypedApp(mkVar("y"), mkVar("z")),
            ),
          ),
        ),
      );

      const expected = arrows(
        arrows(mkTypeVariable("a"), mkTypeVariable("b"), mkTypeVariable("c")),
        arrows(mkTypeVariable("a"), mkTypeVariable("b")),
        arrows(mkTypeVariable("a"), mkTypeVariable("c")),
      );

      const ty = typecheckTypedLambda(typedS);
      assert.strictEqual(typesLitEq(ty, expected), true);
    });
  });
});
