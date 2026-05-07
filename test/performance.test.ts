import { describe, it, before } from "./util/test_shim.ts";
import { hrtime } from "node:process";
import randomSeed from "random-seed";

import type { SKIExpression } from "../lib/ski/expression.ts";
import { randExpression } from "../lib/ski/generator.ts";
import { createArenaEvaluator, thanatosAvailable } from "../lib/index.ts";

describe("evaluator performance", { skip: !thanatosAvailable() }, () => {
  let arenaEvaluator: any;

  before(async () => {
    arenaEvaluator = await createArenaEvaluator();
  });

  const S = 128 * 128; // symbol count in the large generated expression
  const N = 16; // number of times to reduce the large tree

  it("is estimated by measuring the rate of reductions (excluding tree generation)", async () => {
    const seed = hrtime.bigint().toString();
    const rs = randomSeed.create(seed);

    console.log("initiating performance test with seed", seed);

    // Pre-generate one large SKI expression.
    const largeExpr = randExpression(rs, S);

    // Now measure the time spent reducing the large tree.
    const start = hrtime.bigint();
    for (let i = 0; i < N; i++) {
      await arenaEvaluator.reduce(largeExpr);
    }
    const end = hrtime.bigint();
    const elapsedNs = end - start;
    const estimatedReductionDurationNs = elapsedNs / BigInt(N);

    console.log(
      `completed in ${elapsedNs.toString()} ns\n` +
        `for an estimated ${estimatedReductionDurationNs.toString()} ns per reduction\n` +
        `with random seed ${seed} and ${N.toString()} reductions of tree size ${S.toString()}.`,
    );
  });
});
