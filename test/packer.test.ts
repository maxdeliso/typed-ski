import { parse } from '../lib/parser'
import {
  BinaryHeap,
  maxHeapIndex,
  packHeap,
  unpackHeap
} from '../lib/packer'
import { compute, Expression, size } from '../lib/expression'

import { assert } from 'chai'
import { describe, it } from 'mocha'
import { hrtime } from 'process'
import { create } from 'random-seed'

const eye = parse('I')
const dos = parse('II')
const tres = parse('III')
const quattro = parse('SKKI')
const toTheRight = parse('(I(S(KI)))')
const zipper = parse('((I(S(KI)))I)')

describe('packHeap and unpackHeap', () => {
  const assertRepack = (expr: Expression): BinaryHeap => {
    const packed = packHeap(expr)
    const unpacked = unpackHeap(packed)
    assert.deepStrictEqual(expr, unpacked)
    return packed
  }

  it('packs an expression composed of four symbols into three bytes',
    () => {
      const packResult = assertRepack(quattro)
      const unpacked = unpackHeap(packResult)

      assert.deepStrictEqual(size(unpacked), 4)
      assert.deepStrictEqual(packResult.length, 3)
    }
  )

  it('packs and unpacks I to a single byte/symbol',
    () => {
      const singlePackResult = assertRepack(eye)
      const unpackedSingle = unpackHeap(singlePackResult)

      assert.deepStrictEqual(singlePackResult.length, 1)
      assert.deepStrictEqual(size(unpackedSingle), 1)
      assert.deepStrictEqual(eye, unpackedSingle)
    }
  )

  it('packs and unpacks a simple small expression symmetrically',
    () => assertRepack(quattro)
  )

  const S = 8 // symbol count in each randomly generated expression
  const N = 128 // the total number of reductions to complete

  it('packs and unpacks many randomly generated expressions', () => {
    const seed = hrtime.bigint()
    const rs = create(`${seed}`)

    compute(S, N, rs,
      (expr) => assertRepack(expr),
      (expr) => assertRepack(expr))
  })
})

describe('maxHeapIndex', () => {
  it('returns the largest heap index of different shapes',
    () => {
      assert.deepStrictEqual(maxHeapIndex(eye), 0)
      assert.deepStrictEqual(maxHeapIndex(dos), 2)
      assert.deepStrictEqual(maxHeapIndex(tres), 4)
      assert.deepStrictEqual(maxHeapIndex(toTheRight), 14)
      assert.deepStrictEqual(maxHeapIndex(zipper), 22)
    })
})
