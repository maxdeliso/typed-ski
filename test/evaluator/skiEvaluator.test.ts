import { assert } from 'chai';

import { symbolicEvaluator } from '../../lib/evaluator/skiEvaluator.js';
import { parseSKI } from '../../lib/parser/ski.js';
import { SKIExpression, prettyPrint } from '../../lib/ski/expression.js';
import rsexport, { RandomSeed } from 'random-seed';
const { create } = rsexport;
import { randExpression } from '../../lib/ski/generator.js';

describe('stepOnce', () => {
  const first = parseSKI('III');
  const second = parseSKI('II');
  const third = parseSKI('I');
  const fourth = parseSKI('KIS');
  const fifth = parseSKI('SKKI');
  const sixth = parseSKI('SKKII');
  const seventh = parseSKI('KI(KI)');

  const compareExpressions = (a: SKIExpression, b: SKIExpression): void => {
    assert.deepStrictEqual(prettyPrint(a), prettyPrint(b));
  };

  it(`evaluates ${prettyPrint(second)}
      =>
      ${prettyPrint(third)}`, () => {
    const result = symbolicEvaluator.stepOnce(second);
    assert(result.altered);
    compareExpressions(result.expr, third);
  });

  it(`evaluates ${prettyPrint(first)}
      =>
      ${prettyPrint(third)}`,
  () => {
    const firstStep = symbolicEvaluator.stepOnce(first);
    assert(firstStep.altered);
    const secondStep = symbolicEvaluator.stepOnce(firstStep.expr);
    assert(secondStep.altered);
    compareExpressions(secondStep.expr, third);
  });

  it(`evaluates ${prettyPrint(fourth)}
      =>
      ${prettyPrint(third)}`, () => {
    const result = symbolicEvaluator.stepOnce(fourth);
    assert(result.altered);
    compareExpressions(result.expr, third);
  });

  it(`evaluates
      ${prettyPrint(fifth)}
      =>
      ${prettyPrint(seventh)}`, () => {
    const first = symbolicEvaluator.stepOnce(fifth);
    assert(first.altered);
    compareExpressions(first.expr, seventh);
  });

  it(`${prettyPrint(sixth)}
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
    const r = symbolicEvaluator.stepOnce(cur);
    if (!r.altered) return { expr: r.expr, steps: i };
    cur = r.expr;
  }
  throw new Error('stepOnce failed to normalise within maxIter');
}

const seed = 'df394b';
const NORMALISE_TESTS = 19;
const MIN_LENGTH = 5;
const MAX_LENGTH = 12;

describe('stepOnce loop vs. reduce()', () => {
  const rs: RandomSeed = create(seed);

  it(`runs ${NORMALISE_TESTS.toString()} normalization tests with random expressions`, () => {
    [...Array(NORMALISE_TESTS).keys()].forEach((testNum) => {
      const length = rs.intBetween(MIN_LENGTH, MAX_LENGTH);
      const fresh = randExpression(rs, length);
      const normal1 = symbolicEvaluator.reduce(fresh);
      const { expr: normal2, steps } = reduceByLoop(fresh);

      assert.deepStrictEqual(
        prettyPrint(normal2),
        prettyPrint(normal1),
        `Test ${(testNum + 1).toString()}/${NORMALISE_TESTS.toString()} failed: mismatch after ${steps.toString()} stepOnce iterations\n` +
        `Input length: ${length.toString()}\n` +
        `Input expression: ${prettyPrint(fresh)}`
      );

      console.log(`${prettyPrint(fresh)} normalised in ${steps.toString()} steps`);
    });
  });
});
