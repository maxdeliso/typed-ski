import { compute } from '../lib/ski/expression.ts';

import { hrtime } from 'process';

import { Readable } from 'stream';

import randomSeed from 'random-seed';

describe('evaluator performance', () => {
  const S = 64; // symbol count in each randomly generated expression
  const N = 256; // the total number of reductions to complete

  it('is estimated by measuring the rate of reductions', () => {
    const seed = hrtime.bigint.toString();
    const rs = randomSeed.create(seed);
    const start = hrtime.bigint();
    const testOutput = new Readable();
    let generations = 1; // generate upon unaltered evaluation

    compute(S, N, rs,
      () => testOutput.push('.'),
      () => {
        testOutput.push('!');
        generations++;
      });

    const final = hrtime.bigint();
    const elapsedNs = final - start;
    const estimatedReductionDurationNs = elapsedNs / BigInt(N);

    testOutput.push(
      `\ncompleted in ${elapsedNs.toString()} ns
for an estimated ${estimatedReductionDurationNs.toString()} ns per reduction
with random seed ${seed} and ${generations.toString()} generations.`);
    testOutput.push(null);
    testOutput.pipe(process.stdout);
  });
});
