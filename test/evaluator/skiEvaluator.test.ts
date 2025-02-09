import { assert } from 'chai';

import { stepOnceSKI } from '../../lib/evaluator/skiEvaluator.js';
import { parseSKI } from '../../lib/parser/ski.js';
import { SKIExpression, prettyPrint } from '../../lib/ski/expression.js';

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
    assert.deepStrictEqual(a, b);
  };

  it(`evaluates ${prettyPrint(second)}
      =>
      ${prettyPrint(third)}`, () => {
    const result = stepOnceSKI(second);
    assert(result.altered);
    compareExpressions(result.expr, third);
  });

  it(`evaluates ${prettyPrint(first)}
      =>
      ${prettyPrint(third)}`,
  () => {
    const result = stepOnceSKI(stepOnceSKI(first).expr);
    assert(result.altered);
    compareExpressions(result.expr, third);
  });

  it(`evaluates ${prettyPrint(fourth)}
      =>
      ${prettyPrint(third)}`, () => {
    const result = stepOnceSKI(fourth);
    assert(result.altered);
    compareExpressions(result.expr, third);
  });

  it(`evaluates
      ${prettyPrint(fifth)}
      =>
      ${prettyPrint(seventh)}`, () => {
    const first = stepOnceSKI(fifth);
    assert(first.altered);
    compareExpressions(first.expr, seventh);
  });

  it(`${prettyPrint(sixth)}
      =>
      ${prettyPrint(third)}`,
  () => {
    const firstStep = stepOnceSKI(sixth);
    assert(firstStep.altered);
    const secondStep = stepOnceSKI(firstStep.expr);
    assert(secondStep.altered);
    const thirdStep = stepOnceSKI(secondStep.expr);
    assert(thirdStep.altered);
    compareExpressions(thirdStep.expr, third);
  });
});
