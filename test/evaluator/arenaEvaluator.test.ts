import { assert } from 'chai';
import rsexport, { RandomSeed } from 'random-seed';
const { create } = rsexport;

import { arenaEvaluator, fromArena, toArena } from '../../lib/evaluator/arenaEvaluator.js';
import { parseSKI } from '../../lib/parser/ski.js';
import { prettyPrint } from '../../lib/ski/expression.js';
import { randExpression } from '../../lib/ski/generator.js';
import { symbolicEvaluator } from '../../lib/index.js';

describe('stepOnce', () => {
  const first = toArena(parseSKI('III'));
  const second = toArena(parseSKI('II'));
  const third = toArena(parseSKI('I'));
  const fourth = toArena(parseSKI('KIS'));
  const fifth = toArena(parseSKI('SKKI'));
  const sixth = toArena(parseSKI('SKKII'));
  const seventh = toArena(parseSKI('KI(KI)'));

  it(`evaluates ${prettyPrint(fromArena(second))}
      =>
      ${prettyPrint(fromArena(third))}`, () => {
    const result = arenaEvaluator.stepOnce(second);
    assert(result.altered);
    assert(result.expr === third);
  });

  it(`evaluates ${prettyPrint(fromArena(first))}
      =>
      ${prettyPrint(fromArena(third))}`,
  () => {
    const firstStep = arenaEvaluator.stepOnce(first);
    assert(firstStep.altered);
    const secondStep = arenaEvaluator.stepOnce(firstStep.expr);
    assert(secondStep.altered);
    assert(secondStep.expr === third);
  });

  it(`evaluates ${prettyPrint(fromArena(fourth))}
      =>
      ${prettyPrint(fromArena(third))}`, () => {
    const result = arenaEvaluator.stepOnce(fourth);
    assert(result.altered);
    assert(result.expr === third);
  });

  it(`evaluates
      ${prettyPrint(fromArena(fifth))}
      =>
      ${prettyPrint(fromArena(seventh))}`, () => {
    const first = arenaEvaluator.stepOnce(fifth);
    assert(first.altered);
    assert(first.expr === seventh);
  });

  it(`${prettyPrint(fromArena(sixth))}
      =>
      ${prettyPrint(fromArena(third))}`,
  () => {
    const firstStep = arenaEvaluator.stepOnce(sixth);
    assert(firstStep.altered);
    const secondStep = arenaEvaluator.stepOnce(firstStep.expr);
    assert(secondStep.altered);
    const thirdStep = arenaEvaluator.stepOnce(secondStep.expr);
    assert(thirdStep.altered);
    assert(thirdStep.expr === third);
  });
});

const seed = 'df394b';
const NORMALISE_TESTS = 19;
const MIN_LENGTH = 5;
const MAX_LENGTH = 12;

describe('symbolic and arena reduction equivalence', () => {
  const rs: RandomSeed = create(seed);

  it(`runs ${NORMALISE_TESTS.toString()} normalization tests with random expressions`, () => {
    [...Array(NORMALISE_TESTS).keys()].forEach((testNum) => {
      const length = rs.intBetween(MIN_LENGTH, MAX_LENGTH);
      const fresh = randExpression(rs, length);
      const normal1 = fromArena(arenaEvaluator.reduce(toArena(fresh)));
      const normal2 = symbolicEvaluator.reduce(fresh);

      assert.deepStrictEqual(
        prettyPrint(normal2),
        prettyPrint(normal1),
        `Test ${(testNum + 1).toString()}/${NORMALISE_TESTS.toString()} failed: mismatch\n` +
        `Input length: ${length.toString()}\n` +
        `Input expression: ${prettyPrint(fresh)}`
      );
    });
  });
});
