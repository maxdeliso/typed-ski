import { test } from "node:test";
import { expect } from "../util/assertions.ts";

import { mkVar } from "../../lib/terms/lambda.ts";
import {
  addBinding,
  emptyContext,
  typecheckTypedLambda,
} from "../../lib/types/typedLambda.ts";
import { createTypedApplication, mkTypedAbs } from "../util/ast.ts";
import {
  arrow,
  arrows,
  mkTypeVariable,
  typesLitEq,
} from "../../lib/types/types.ts";

test("typed λ-calculus type-checker", async (t) => {
  await t.test("type-checking errors", async (t) => {
    await t.test("free variable triggers error", () => {
      expect(() => typecheckTypedLambda(mkVar("x"))).to.throw(
        /unbound variable x/,
      );
    });

    await t.test("duplicate binding in context", () => {
      let ctx = emptyContext();
      ctx = addBinding(ctx, "x", mkTypeVariable("a"));
      expect(() => addBinding(ctx, "x", mkTypeVariable("b"))).to.throw(
        /variable x already bound in context/,
      );
    });
  });

  await t.test("successful type-checks", async (t) => {
    await t.test("I combinator (λx:a.x)", () => {
      const typedI = mkTypedAbs("x", mkTypeVariable("a"), mkVar("x"));
      const ty = typecheckTypedLambda(typedI);
      expect(
        typesLitEq(ty, arrow(mkTypeVariable("a"), mkTypeVariable("a"))),
      ).to.equal(true);
    });

    await t.test("K combinator", () => {
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
      expect(typesLitEq(ty, expected)).to.equal(true);
    });

    await t.test("S combinator", () => {
      const typedS = mkTypedAbs(
        "x",
        arrows(mkTypeVariable("a"), mkTypeVariable("b"), mkTypeVariable("c")),
        mkTypedAbs(
          "y",
          arrow(mkTypeVariable("a"), mkTypeVariable("b")),
          mkTypedAbs(
            "z",
            mkTypeVariable("a"),
            createTypedApplication(
              createTypedApplication(mkVar("x"), mkVar("z")),
              createTypedApplication(mkVar("y"), mkVar("z")),
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
      expect(typesLitEq(ty, expected)).to.equal(true);
    });
  });
});
