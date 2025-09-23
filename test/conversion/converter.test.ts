import { expect } from "chai";

import { cons } from "../../lib/cons.ts";
import { predLambda } from "../../lib/consts/lambdas.ts";
import { symbolicEvaluator } from "../../lib/evaluator/skiEvaluator.ts";
import { ChurchN, UnChurchNumber } from "../../lib/ski/church.ts";
import { apply } from "../../lib/ski/expression.ts";
import { I } from "../../lib/ski/terminal.ts";
import { bracketLambda } from "../../lib/conversion/converter.ts";
import { mkUntypedAbs, mkVar } from "../../lib/terms/lambda.ts";

Deno.test("Lambda conversion", async (t) => {
  const N = 5;
  const id = mkUntypedAbs("x", mkVar("x"));
  const konst = mkUntypedAbs("x", mkUntypedAbs("y", mkVar("x")));
  const flip = mkUntypedAbs(
    "x",
    mkUntypedAbs("y", cons(mkVar("y"), mkVar("x"))),
  );

  await t.step("basic combinators", async (t) => {
    await t.step("converts identity function (λx.x) to I combinator", () => {
      expect(bracketLambda(id)).to.deep.equal(I);
    });

    await t.step(
      "converts K-like function (λx.λy.x) to equivalent SKI term",
      () => {
        // The K combinator should return its first argument.
        for (let a = 0; a < N; a++) {
          for (let b = 0; b < N; b++) {
            const result = UnChurchNumber(
              symbolicEvaluator.reduce(
                apply(bracketLambda(konst), ChurchN(a), ChurchN(b)),
              ),
            );
            expect(result).to.equal(a);
          }
        }
      },
    );
  });

  await t.step("arithmetic operations", async (t) => {
    await t.step("computes exponentiation using flip combinator", () => {
      /**
       * flip is defined as:    flip ≡ λx.λy. y x
       *
       * When applied to Church numerals a and b:
       *   flip a b = (λx.λy. y x) a b
       *           = (λy. y a) b
       *           = b a
       *
       * In Church encoding, numeral b represents: λf.λx. fᵇ(x)
       * so "b a" means applying the function a b times,
       * i.e. computing aᵇ (a raised to the power of b).
       *
       * Therefore, semantically, flip a b should evaluate to aᵇ.
       */
      for (let a = 0; a < N; a++) {
        for (let b = 0; b < N; b++) {
          const expected = a ** b; // exponentiation: a^b
          const result = UnChurchNumber(
            symbolicEvaluator.reduce(
              apply(bracketLambda(flip), ChurchN(a), ChurchN(b)),
            ),
          );
          expect(result).to.equal(expected);
        }
      }
    });

    await t.step("converts predecessor function to equivalent SKI term", () => {
      for (let n = 0; n < N; n++) {
        const expected = Math.max(n - 1, 0); // pred(0) is defined as 0.
        const result = UnChurchNumber(
          symbolicEvaluator.reduce(
            apply(bracketLambda(predLambda), ChurchN(n)),
          ),
        );
        expect(result).to.equal(expected);
      }
    });
  });
});
