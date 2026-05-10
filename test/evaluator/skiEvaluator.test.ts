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
import { createArenaEvaluator, thanatosAvailable } from "../../lib/index.ts";

const compareExpressions = (a: SKIExpression, b: SKIExpression): void => {
  assert.deepStrictEqual(unparseSKI(a), unparseSKI(b));
};

describe("compatibility step", { skip: !thanatosAvailable() }, () => {
  let arenaEvaluator: any;

  before(async () => {
    arenaEvaluator = await createArenaEvaluator();
  });

  it("normalizes through the Thanatos delegator", async () => {
    const result = await arenaEvaluator.step(parseSKI("SKKII"));
    assert.ok(result.altered);
    compareExpressions(result.expr, I);
  });
});

describe("B and C combinators", { skip: !thanatosAvailable() }, () => {
  let arenaEvaluator: any;

  before(async () => {
    arenaEvaluator = await createArenaEvaluator();
  });

  it("B x y z = x (y z)", async () => {
    const expr = applyMany(B, I, I, I);
    const reduced = await arenaEvaluator.reduce(expr);
    compareExpressions(reduced, I);
  });

  it("B with distinct args preserves order", async () => {
    const left = await arenaEvaluator.reduce(applyMany(B, K, I, S));
    const right = await arenaEvaluator.reduce(applyMany(K, applyMany(I, S)));
    compareExpressions(left, right);
  });

  it("C x y z = x z y", async () => {
    const expr = applyMany(C, I, I, I);
    const reduced = await arenaEvaluator.reduce(expr);
    compareExpressions(reduced, I);
  });

  it("C with distinct args preserves order", async () => {
    const left = await arenaEvaluator.reduce(applyMany(C, K, I, S));
    const right = await arenaEvaluator.reduce(applyMany(K, S, I));
    compareExpressions(left, right);
  });
});
