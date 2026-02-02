import { assert } from "chai";

import { arenaEvaluator } from "../../lib/evaluator/skiEvaluator.ts";
import { parseSKI } from "../../lib/parser/ski.ts";
import {
  applyMany,
  type SKIExpression,
  unparseSKI,
} from "../../lib/ski/expression.ts";
import { B, C, I } from "../../lib/ski/terminal.ts";
import rsexport, { type RandomSeed } from "random-seed";
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
    assert.deepStrictEqual(unparseSKI(a), unparseSKI(b));
  };

  await t.step(
    `evaluates ${unparseSKI(second)}
      =>
      ${unparseSKI(third)}`,
    () => {
      const result = arenaEvaluator.stepOnce(second);
      assert(result.altered);
      compareExpressions(result.expr, third);
    },
  );

  await t.step(
    `evaluates ${unparseSKI(first)}
      =>
      ${unparseSKI(third)}`,
    () => {
      const firstStep = arenaEvaluator.stepOnce(first);
      assert(firstStep.altered);
      const secondStep = arenaEvaluator.stepOnce(firstStep.expr);
      assert(secondStep.altered);
      compareExpressions(secondStep.expr, third);
    },
  );

  await t.step(
    `evaluates ${unparseSKI(fourth)}
      =>
      ${unparseSKI(third)}`,
    () => {
      const result = arenaEvaluator.stepOnce(fourth);
      assert(result.altered);
      compareExpressions(result.expr, third);
    },
  );

  await t.step(
    `evaluates
      ${unparseSKI(fifth)}
      =>
      ${unparseSKI(seventh)}`,
    () => {
      const first = arenaEvaluator.stepOnce(fifth);
      assert(first.altered);
      compareExpressions(first.expr, seventh);
    },
  );

  await t.step(
    `${unparseSKI(sixth)}
      =>
      ${unparseSKI(third)}`,
    () => {
      const firstStep = arenaEvaluator.stepOnce(sixth);
      assert(firstStep.altered);
      const secondStep = arenaEvaluator.stepOnce(firstStep.expr);
      assert(secondStep.altered);
      const thirdStep = arenaEvaluator.stepOnce(secondStep.expr);
      assert(thirdStep.altered);
      compareExpressions(thirdStep.expr, third);
    },
  );
});

Deno.test("B and C combinators", async (t) => {
  const compareExpressions = (a: SKIExpression, b: SKIExpression): void => {
    assert.deepStrictEqual(unparseSKI(a), unparseSKI(b));
  };

  await t.step("B x y z = x (y z)", () => {
    const expr = applyMany(B, I, I, I);
    const reduced = arenaEvaluator.reduce(expr);
    compareExpressions(reduced, I);
  });

  await t.step("C x y z = x z y", () => {
    const expr = applyMany(C, I, I, I);
    const reduced = arenaEvaluator.reduce(expr);
    compareExpressions(reduced, I);
  });
});

const MAX_ITER = 100;

/**
 * Drive stepOnce until it returns { altered:false, expr:e }
 * and count how many iterations it took.
 */
function reduceByLoop(expr: SKIExpression, maxIter = MAX_ITER) {
  let cur = expr;
  for (let i = 0; i < maxIter; i++) {
    const r = arenaEvaluator.stepOnce(cur);
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
        const reducedOnce = arenaEvaluator.reduce(fresh);
        const { expr: reducedMany } = reduceByLoop(fresh);

        assert.deepStrictEqual(
          unparseSKI(reducedOnce),
          unparseSKI(reducedMany),
          `expected: ${unparseSKI(reducedOnce)}, got: ${
            unparseSKI(reducedMany)
          }`,
        );
      });
    },
  );
});
