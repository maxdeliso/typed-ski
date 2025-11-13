import { hrtime } from "node:process";
import randomSeed from "random-seed";

import type { SKIExpression } from "../lib/ski/expression.ts";
import { arenaEvaluator } from "../lib/evaluator/skiEvaluator.ts";
import { randExpression } from "../lib/ski/generator.ts";

Deno.test("evaluator performance", async (t) => {
  const S = 128; // symbol count in each generated expression
  const N = 2048; // number of reductions to perform

  await t.step(
    "is estimated by measuring the rate of reductions (excluding tree generation)",
    () => {
      const seed = hrtime.bigint().toString();
      const rs = randomSeed.create(seed);

      console.log("initiating performance test with seed", seed);

      // Pre-generate N SKI expressions.
      const expressions: SKIExpression[] = [];
      for (let i = 0; i < N; i++) {
        expressions.push(randExpression(rs, S));
      }

      // Now measure the time spent reducing the pre-generated trees.
      const start = hrtime.bigint();
      for (const expr of expressions) {
        arenaEvaluator.stepOnce(expr);
      }
      const end = hrtime.bigint();
      const elapsedNs = end - start;
      const estimatedReductionDurationNs = elapsedNs / BigInt(N);

      console.log(
        `completed in ${elapsedNs.toString()} ns\n` +
          `for an estimated ${estimatedReductionDurationNs.toString()} ns per reduction step\n` +
          `with random seed ${seed} and ${N.toString()} reductions.`,
      );
    },
  );
});
