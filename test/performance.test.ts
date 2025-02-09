import { hrtime } from 'process';
import randomSeed from 'random-seed';

import { generateExpr, SKIExpression } from '../lib/ski/expression.ts';
import { stepOnceImmediate } from '../lib/evaluator/skiEvaluator.ts';

describe('evaluator performance', () => {
  const S = 128; // symbol count in each generated expression
  const N = 2048; // number of reductions to perform

  it('is estimated by measuring the rate of reductions (excluding tree generation)', () => {
    const seed = hrtime.bigint().toString();
    const rs = randomSeed.create(seed);

    console.log('initiating performance test with seed', seed);

    // Pre-generate N SKI expressions.
    const expressions: SKIExpression[] = [];
    for (let i = 0; i < N; i++) {
      expressions.push(generateExpr(rs, S));
    }

    // Now measure the time spent reducing the pre-generated trees.
    const start = hrtime.bigint();
    for (const expr of expressions) {
      stepOnceImmediate(expr);
    }
    const end = hrtime.bigint();
    const elapsedNs = end - start;
    const estimatedReductionDurationNs = elapsedNs / BigInt(N);

    console.log(
      `completed in ${elapsedNs.toString()} ns\n` +
      `for an estimated ${estimatedReductionDurationNs.toString()} ns per reduction step\n` +
      `with random seed ${seed} and ${N.toString()} reductions.`
    );
  });
});
