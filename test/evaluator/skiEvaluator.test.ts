import { test } from "node:test";
import assert from "node:assert/strict";

import { arenaEvaluator } from "../../lib/evaluator/skiEvaluator.ts";
import { parseSKI } from "../../lib/parser/ski.ts";
import {
  applyMany,
  type SKIExpression,
  unparseSKI,
} from "../../lib/ski/expression.ts";
import { B, C, I, K, S } from "../../lib/ski/terminal.ts";
import rsexport, { type RandomSeed } from "random-seed";
const { create } = rsexport;
import { randExpression } from "../../lib/ski/generator.ts";

test("stepOnce", async (t) => {
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

  await t.test(
    `evaluates ${unparseSKI(second)}
      =>
      ${unparseSKI(third)}`,
    () => {
      const result = arenaEvaluator.stepOnce(second);
      assert.ok(result.altered);
      compareExpressions(result.expr, third);
    },
  );

  await t.test(
    `evaluates ${unparseSKI(first)}
      =>
      ${unparseSKI(third)}`,
    () => {
      const firstStep = arenaEvaluator.stepOnce(first);
      assert.ok(firstStep.altered);
      const secondStep = arenaEvaluator.stepOnce(firstStep.expr);
      assert.ok(secondStep.altered);
      compareExpressions(secondStep.expr, third);
    },
  );

  await t.test(
    `evaluates ${unparseSKI(fourth)}
      =>
      ${unparseSKI(third)}`,
    () => {
      const result = arenaEvaluator.stepOnce(fourth);
      assert.ok(result.altered);
      compareExpressions(result.expr, third);
    },
  );

  await t.test(
    `evaluates
      ${unparseSKI(fifth)}
      =>
      ${unparseSKI(seventh)}`,
    () => {
      const first = arenaEvaluator.stepOnce(fifth);
      assert.ok(first.altered);
      compareExpressions(first.expr, seventh);
    },
  );

  await t.test(
    `${unparseSKI(sixth)}
      =>
      ${unparseSKI(third)}`,
    () => {
      const firstStep = arenaEvaluator.stepOnce(sixth);
      assert.ok(firstStep.altered);
      const secondStep = arenaEvaluator.stepOnce(firstStep.expr);
      assert.ok(secondStep.altered);
      const thirdStep = arenaEvaluator.stepOnce(secondStep.expr);
      assert.ok(thirdStep.altered);
      compareExpressions(thirdStep.expr, third);
    },
  );
});

test("B and C combinators", async (t) => {
  const compareExpressions = (a: SKIExpression, b: SKIExpression): void => {
    assert.deepStrictEqual(unparseSKI(a), unparseSKI(b));
  };

  await t.test("B x y z = x (y z)", () => {
    const expr = applyMany(B, I, I, I);
    const reduced = arenaEvaluator.reduce(expr);
    compareExpressions(reduced, I);
  });

  await t.test("B with distinct args preserves order", () => {
    const left = arenaEvaluator.reduce(applyMany(B, K, I, S));
    const right = arenaEvaluator.reduce(applyMany(K, applyMany(I, S)));
    compareExpressions(left, right);
  });

  await t.test("C x y z = x z y", () => {
    const expr = applyMany(C, I, I, I);
    const reduced = arenaEvaluator.reduce(expr);
    compareExpressions(reduced, I);
  });

  await t.test("C with distinct args preserves order", () => {
    const left = arenaEvaluator.reduce(applyMany(C, K, I, S));
    const right = arenaEvaluator.reduce(applyMany(K, S, I));
    compareExpressions(left, right);
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

test("stepOnce loop vs. reduce()", async (t) => {
  const seed = "df394b";
  const normalizeTests = 19;
  const minLength = 5;
  const maxLength = 12;
  const rs: RandomSeed = create(seed);

  await t.test(
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
          `expected: ${unparseSKI(reducedOnce)}, got: ${unparseSKI(
            reducedMany,
          )}`,
        );
      });
    },
  );
});
