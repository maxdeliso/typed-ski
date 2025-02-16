import { assert } from 'chai';

import { stepOnce } from '../../lib/evaluator/skiEvaluator.js';
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
  };

  it(`evaluates ${prettyPrint(second)}
      =>
      ${prettyPrint(third)}`, () => {
    const result = stepOnce(second);
    assert(result.altered);
    compareExpressions(result.expr, third);
  });

  it(`evaluates ${prettyPrint(first)}
      =>
      ${prettyPrint(third)}`,
  () => {
    const firstStep = stepOnce(first);
    assert(firstStep.altered);
    const secondStep = stepOnce(firstStep.expr);
    assert(secondStep.altered);
    compareExpressions(secondStep.expr, third);
  });

  it(`evaluates ${prettyPrint(fourth)}
      =>
      ${prettyPrint(third)}`, () => {
    const result = stepOnce(fourth);
    assert(result.altered);
    compareExpressions(result.expr, third);
  });

  it(`evaluates
      ${prettyPrint(fifth)}
      =>
      ${prettyPrint(seventh)}`, () => {
    const first = stepOnce(fifth);
    assert(first.altered);
    compareExpressions(first.expr, seventh);
  });

  it(`${prettyPrint(sixth)}
      =>
      ${prettyPrint(third)}`,
  () => {
    const firstStep = stepOnce(sixth);
    assert(firstStep.altered);
    const secondStep = stepOnce(firstStep.expr);
    assert(secondStep.altered);
    const thirdStep = stepOnce(secondStep.expr);
    assert(thirdStep.altered);
    compareExpressions(thirdStep.expr, third);
  });
});
