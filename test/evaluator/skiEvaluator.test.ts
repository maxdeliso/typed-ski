import { assert } from "npm:chai";

import { symbolicEvaluator } from "../../lib/evaluator/skiEvaluator.ts";
import { parseSKI } from "../../lib/parser/ski.ts";
import { prettyPrint, SKIExpression } from "../../lib/ski/expression.ts";
import rsexport, { RandomSeed } from "npm:random-seed";
const { create } = rsexport;
import { randExpression } from "../../lib/ski/generator.ts";

Deno.test("stepOnce", async (t) => {
  const first = parseSKI("III");
  const second = parseSKI("II");
  const third = parseSKI("I");
  const fourth = parseSKI("KIS");
  const fifth = parseSKI("SKKI");
  const sixth = parseSKI("SKKII");
  const seventh = parseSKI("KI(KI)");

  const compareExpressions = (a: SKIExpression, b: SKIExpression): void => {
    assert.deepStrictEqual(prettyPrint(a), prettyPrint(b));
  };

  await t.step(
    `evaluates ${prettyPrint(second)}
      =>
      ${prettyPrint(third)}`,
    () => {
      const result = symbolicEvaluator.stepOnce(second);
      assert(result.altered);
      compareExpressions(result.expr, third);
    },
  );

  await t.step(
    `evaluates ${prettyPrint(first)}
      =>
      ${prettyPrint(third)}`,
    () => {
      const firstStep = symbolicEvaluator.stepOnce(first);
      assert(firstStep.altered);
      const secondStep = symbolicEvaluator.stepOnce(firstStep.expr);
      assert(secondStep.altered);
      compareExpressions(secondStep.expr, third);
    },
  );

  await t.step(
    `evaluates ${prettyPrint(fourth)}
      =>
      ${prettyPrint(third)}`,
    () => {
      const result = symbolicEvaluator.stepOnce(fourth);
      assert(result.altered);
      compareExpressions(result.expr, third);
    },
  );

  await t.step(
    `evaluates
      ${prettyPrint(fifth)}
      =>
      ${prettyPrint(seventh)}`,
    () => {
      const first = symbolicEvaluator.stepOnce(fifth);
      assert(first.altered);
      compareExpressions(first.expr, seventh);
    },
  );

  await t.step(
    `${prettyPrint(sixth)}
      =>
      ${prettyPrint(third)}`,
    () => {
      const firstStep = symbolicEvaluator.stepOnce(sixth);
      assert(firstStep.altered);
      const secondStep = symbolicEvaluator.stepOnce(firstStep.expr);
      assert(secondStep.altered);
      const thirdStep = symbolicEvaluator.stepOnce(secondStep.expr);
      assert(thirdStep.altered);
      compareExpressions(thirdStep.expr, third);
    },
  );
});

const MAX_ITER = 100;

/**
 * Drive stepOnce until it returns { altered:false, expr:e }
 * and count how many iterations it took.
 */
function reduceByLoop(expr: SKIExpression, maxIter = MAX_ITER) {
  let cur = expr;
  for (let i = 0; i < maxIter; i++) {
    const r = symbolicEvaluator.stepOnce(cur);
    if (!r.altered) return { expr: r.expr, steps: i };
    cur = r.expr;
  }
  throw new Error("stepOnce failed to normalise within maxIter");
}

Deno.test("stepOnce loop vs. reduce()", async (t) => {
  const seed = "df394b";
  const normalizeTests = 19;
  const minLength = 5;
  const maxLength = 12;
  const rs: RandomSeed = create(seed);

  await t.step(
    `runs ${normalizeTests.toString()} normalization tests with random expressions`,
    () => {
      [...Array(normalizeTests).keys()].forEach(() => {
        const length = rs.intBetween(minLength, maxLength);
        const fresh = randExpression(rs, length);
        const reducedOnce = symbolicEvaluator.reduce(fresh);
        const { expr: reducedMany } = reduceByLoop(fresh);

        assert.deepStrictEqual(
          prettyPrint(reducedOnce),
          prettyPrint(reducedMany),
          `expected: ${prettyPrint(reducedOnce)}, got: ${
            prettyPrint(reducedMany)
          }`,
        );
      });
    },
  );
});
