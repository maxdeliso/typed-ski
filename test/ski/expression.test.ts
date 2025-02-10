import { assert } from 'chai';
import rsexport, { RandomSeed } from 'random-seed';
const { create } = rsexport;

import { cons } from '../../lib/cons.js';
import { SKIExpression, prettyPrint, size } from '../../lib/ski/expression.js';
import { S, K } from '../../lib/ski/terminal.js';
import { randExpression } from '../../lib/ski/generator.js';

describe('prettyPrint', () => {
  const expr = cons<SKIExpression>(cons<SKIExpression>(S, K), K);
  const printedExpr = '((SK)K)';

  it('pretty prints a valid expression',
    () => { assert.deepStrictEqual(prettyPrint(expr), printedExpr); }
  );
});

describe('generate', () => {
  const testSeed = '18477814418';
  const n = 8;

  it('generates a random expression with the specified size', () => {
    const rs: RandomSeed = create(testSeed);
    const generated = randExpression(rs, n);

    assert.deepStrictEqual(n, size(generated));
  });
});
