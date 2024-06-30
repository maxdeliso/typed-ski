import {
  SKIExpression,
  generate,
  prettyPrint,
  size
} from '../../lib/ski/expression'
import { nt } from '../../lib/nonterminal'
import { K, S } from '../../lib/ski/terminal'

import { assert } from 'chai'
import { RandomSeed, create } from 'random-seed'

describe('prettyPrint', () => {
  const expr = nt<SKIExpression>(nt<SKIExpression>(S, K), K)
  const printedExpr = '((SK)K)'

  it('pretty prints a valid expression',
    () => { assert.deepStrictEqual(prettyPrint(expr), printedExpr); }
  )
})

describe('generate', () => {
  const testSeed = '18477814418'
  const n = 8

  it('generates a random expression with the specified size', () => {
    const rs: RandomSeed = create(testSeed)
    const generated = generate(rs, n)

    assert.deepStrictEqual(n, size(generated))
  })
})
