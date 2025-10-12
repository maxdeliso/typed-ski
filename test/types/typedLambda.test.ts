import { expect } from "chai";

import { mkVar } from "../../lib/terms/lambda.ts";
import {
  addBinding,
  createTypedApplication,
  emptyContext,
  mkTypedAbs,
  typecheckTypedLambda,
} from "../../lib/types/typedLambda.ts";
import {
  arrow,
  arrows,
  mkTypeVariable,
  typesLitEq,
} from "../../lib/types/types.ts";

Deno.test("typed λ-calculus type-checker", async (t) => {
  await t.step("type-checking errors", async (t) => {
    await t.step("free variable triggers error", () => {
      expect(() => typecheckTypedLambda(mkVar("x")))
        .to.throw(/unknown term named: x/);
    });

    await t.step("duplicate binding in context", () => {
      let ctx = emptyContext();
      ctx = addBinding(ctx, "x", mkTypeVariable("a"));
      expect(() => addBinding(ctx, "x", mkTypeVariable("b")))
        .to.throw(/duplicated binding for name: x/);
    });
  });

  await t.step("successful type-checks", async (t) => {
    await t.step("I combinator (λx:a.x)", () => {
      const typedI = mkTypedAbs("x", mkTypeVariable("a"), mkVar("x"));
      const ty = typecheckTypedLambda(typedI);
      expect(typesLitEq(ty, arrow(mkTypeVariable("a"), mkTypeVariable("a"))))
        .to.equal(true);
    });

    await t.step("K combinator", () => {
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

    await t.step("S combinator", () => {
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
