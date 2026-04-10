import { describe, it, before } from "../util/test_shim.ts";
import assert from "node:assert/strict";

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
import { createArenaEvaluator } from "../../lib/index.ts";

const compareExpressions = (a: SKIExpression, b: SKIExpression): void => {
  assert.deepStrictEqual(unparseSKI(a), unparseSKI(b));
};

describe("stepOnce", () => {
  const first = parseSKI("III");
  const second = parseSKI("II");
  const third = parseSKI("I");
  const fourth = parseSKI("KIS");
  const fifth = parseSKI("SKKI");
  const sixth = parseSKI("SKKII");
  const seventh = parseSKI("KI(KI)");

  let arenaEvaluator: any;

  before(async () => {
    arenaEvaluator = await createArenaEvaluator();
  });

  it(`evaluates ${unparseSKI(second)}
      =>
      ${unparseSKI(third)}`, () => {
    const result = arenaEvaluator.stepOnce(second);
    assert.ok(result.altered);
    compareExpressions(result.expr, third);
  });

  it(`evaluates ${unparseSKI(first)}
      =>
      ${unparseSKI(third)}`, () => {
    const firstStep = arenaEvaluator.stepOnce(first);
    assert.ok(firstStep.altered);
    const secondStep = arenaEvaluator.stepOnce(firstStep.expr);
    assert.ok(secondStep.altered);
    compareExpressions(secondStep.expr, third);
  });

  it(`evaluates ${unparseSKI(fourth)}
      =>
      ${unparseSKI(third)}`, () => {
    const result = arenaEvaluator.stepOnce(fourth);
    assert.ok(result.altered);
    compareExpressions(result.expr, third);
  });

  it(`evaluates
      ${unparseSKI(fifth)}
      =>
      ${unparseSKI(seventh)}`, () => {
    const first = arenaEvaluator.stepOnce(fifth);
    assert.ok(first.altered);
    compareExpressions(first.expr, seventh);
  });

  it(`${unparseSKI(sixth)}
      =>
      ${unparseSKI(third)}`, () => {
    const firstStep = arenaEvaluator.stepOnce(sixth);
    assert.ok(firstStep.altered);
    const secondStep = arenaEvaluator.stepOnce(firstStep.expr);
    assert.ok(secondStep.altered);
    const thirdStep = arenaEvaluator.stepOnce(secondStep.expr);
    assert.ok(thirdStep.altered);
    compareExpressions(thirdStep.expr, third);
  });
});

describe("B and C combinators", () => {
  let arenaEvaluator: any;

  before(async () => {
    arenaEvaluator = await createArenaEvaluator();
  });

  it("B x y z = x (y z)", () => {
    const expr = applyMany(B, I, I, I);
    const reduced = arenaEvaluator.reduce(expr);
    compareExpressions(reduced, I);
  });

  it("B with distinct args preserves order", () => {
    const left = arenaEvaluator.reduce(applyMany(B, K, I, S));
    const right = arenaEvaluator.reduce(applyMany(K, applyMany(I, S)));
    compareExpressions(left, right);
  });

  it("C x y z = x z y", () => {
    const expr = applyMany(C, I, I, I);
    const reduced = arenaEvaluator.reduce(expr);
    compareExpressions(reduced, I);
  });

  it("C with distinct args preserves order", () => {
    const left = arenaEvaluator.reduce(applyMany(C, K, I, S));
    const right = arenaEvaluator.reduce(applyMany(K, S, I));
    compareExpressions(left, right);
  });
});

const MAX_ITER = 100;

describe("stepOnce loop vs. reduce()", () => {
  const seed = "df394b";
  const normalizeTests = 19;
  const minLength = 5;
  const maxLength = 12;
  let arenaEvaluator: any;
  let rs: RandomSeed;

  before(async () => {
    arenaEvaluator = await createArenaEvaluator();
    rs = create(seed);
  });

  function reduceByLoop(expr: SKIExpression, max: number) {
    let cur = expr;
    for (let i = 0; i < max; i++) {
      const r = arenaEvaluator.stepOnce(cur);
      if (!r.altered) return { expr: r.expr, steps: i };
      cur = r.expr;
    }
    throw new Error("stepOnce failed to normalise within maxIter");
  }

  it(`runs ${normalizeTests.toString()} normalization tests with random expressions`, () => {
    [...Array(normalizeTests).keys()].forEach(() => {
      const length = rs.intBetween(minLength, maxLength);
      const fresh = randExpression(rs, length);

      const reduced = arenaEvaluator.reduce(fresh, MAX_ITER);
      const { expr: reducedMany } = reduceByLoop(fresh, MAX_ITER);

      assert.deepStrictEqual(
        unparseSKI(reduced),
        unparseSKI(reducedMany),
        `expected: ${unparseSKI(reduced)}, got: ${unparseSKI(reducedMany)}`,
      );
    });
  });
});
