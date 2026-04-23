import assert from "node:assert/strict";
import rsexport, { type RandomSeed } from "random-seed";
import { it } from "../util/test_shim.ts";
import { createArenaEvaluator } from "../../lib/index.ts";
import { parseSKI } from "../../lib/parser/ski.ts";
import { applyMany, unparseSKI } from "../../lib/ski/expression.ts";
import { randExpression } from "../../lib/ski/generator.ts";
import { optimizeSKI } from "../../lib/ski/optimizer.ts";

const { create } = rsexport;

function optimize(source: string): string {
  return unparseSKI(optimizeSKI(parseSKI(source)));
}

it("optimizes B over an applied head into B'", () => {
  assert.equal(optimize("((B(KI))S)"), "(((QK)I)S)");
});

it("optimizes S over a composed head into S'", () => {
  assert.equal(optimize("((S((BK)I))C)"), "(((PK)I)C)");
});

it("optimizes C over a composed head into C'", () => {
  assert.equal(optimize("((C((BK)I))S)"), "(((RK)I)S)");
});

it("optimizes S(Kx)y into Bxy", () => {
  assert.equal(optimize("((S(KI))B)"), "((BI)B)");
});

it("optimizes Sx(Ky) into Cxy", () => {
  assert.equal(optimize("((SB)(KI))"), "((CB)I)");
});

it("preserves semantics for optimized rewrite patterns under random pure arguments", async () => {
  const evaluator = await createArenaEvaluator();
  const random: RandomSeed = create("optimizer-semantics");
  const rewriteSources = [
    "((B(KI))S)",
    "((S((BK)I))C)",
    "((C((BK)I))S)",
    "((S(KI))B)",
    "((SB)(KI))",
  ];

  try {
    for (const source of rewriteSources) {
      const original = parseSKI(source);
      const optimized = optimizeSKI(original);

      for (let sample = 0; sample < 6; sample++) {
        const args = [
          randExpression(random, 4 + sample),
          randExpression(random, 5 + sample),
          randExpression(random, 6 + sample),
          randExpression(random, 7 + sample),
        ];
        const originalReduced = evaluator.reduce(
          applyMany(original, ...args),
          1000,
        );
        const optimizedReduced = evaluator.reduce(
          applyMany(optimized, ...args),
          1000,
        );

        assert.equal(
          unparseSKI(optimizedReduced),
          unparseSKI(originalReduced),
          `optimized form changed semantics for ${source}`,
        );
      }
    }
  } finally {
    const maybeTerminable = evaluator as unknown as {
      terminate?: () => void;
    };
    if (typeof maybeTerminable.terminate === "function") {
      maybeTerminable.terminate();
    }
  }
});
