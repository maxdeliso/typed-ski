import { assert } from 'chai';
import { describe, it } from 'mocha';
import rsexport from 'random-seed';
const { create } = rsexport;

import { parseSKI } from '../../lib/parser/ski.ts';
import { SKIExpression, size, compute } from '../../lib/ski/expression.ts';
import { BinaryHeap, packHeap, unpackHeap, maxHeapIndex } from '../../lib/ski/packer.ts';

describe('packHeap and unpackHeap', () => {
  const eye = parseSKI('I');
  const quattro = parseSKI('SKKI');

  const assertRepack = (expr: SKIExpression): BinaryHeap => {
    const packed = packHeap(expr);
    const unpacked = unpackHeap(packed);
    assert.deepStrictEqual(expr, unpacked);
    return packed;
  };

  it('packs an expression composed of four symbols into three bytes',
    () => {
      const packResult = assertRepack(quattro);
      const unpacked = unpackHeap(packResult);

      assert.deepStrictEqual(size(unpacked), 4);
      assert.deepStrictEqual(packResult.length, 3);
    }
  );

  it('packs and unpacks I to a single byte/symbol',
    () => {
      const singlePackResult = assertRepack(eye);
      const unpackedSingle = unpackHeap(singlePackResult);

      assert.deepStrictEqual(singlePackResult.length, 1);
      assert.deepStrictEqual(size(unpackedSingle), 1);
      assert.deepStrictEqual(eye, unpackedSingle);
    }
  );

  it('packs and unpacks a simple small expression symmetrically',
    () => assertRepack(quattro)
  );

  const S = 8; // symbol count in each randomly generated expression
  const N = 128; // the total number of reductions to complete

  it('packs and unpacks many randomly generated expressions', () => {
    const rs = create('testing');

    compute(S, N, rs,
      (expr) => assertRepack(expr),
      (expr) => assertRepack(expr));
  });
});

describe('maxHeapIndex', () => {
  const eye = parseSKI('I');
  const dos = parseSKI('II');
  const tres = parseSKI('III');
  const toTheRight = parseSKI('(I(S(KI)))');
  const zipper = parseSKI('((I(S(KI)))I)');

  it('returns the largest heap index of different shapes',
    () => {
      assert.deepStrictEqual(maxHeapIndex(eye), 0);
      assert.deepStrictEqual(maxHeapIndex(dos), 2);
      assert.deepStrictEqual(maxHeapIndex(tres), 4);
      assert.deepStrictEqual(maxHeapIndex(toTheRight), 14);
      assert.deepStrictEqual(maxHeapIndex(zipper), 22);
    });
});
