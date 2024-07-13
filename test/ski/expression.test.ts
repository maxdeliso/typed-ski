import { cons } from '../../lib/cons.ts';
import { SKIExpression, generateExpr, prettyPrint, size } from '../../lib/ski/expression.ts';
import { S, K } from '../../lib/ski/terminal.ts';

import { assert } from 'chai';

import rsexport, { RandomSeed } from 'random-seed';
const { create } = rsexport;

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
    const generated = generateExpr(rs, n);

    assert.deepStrictEqual(n, size(generated));
  });
});
