import { Expression, generate, prettyPrint, size } from '../lib/expression.mjs'
import { nt } from '../lib/nonterminal.mjs'
import { K, S } from '../lib/terminal.mjs'

import { assert } from 'chai'
import pkg, { RandomSeed } from 'random-seed'
const { create } = pkg

describe('prettyPrint', () => {
  const expr = nt<Expression>(nt<Expression>(S, K), K)
  const printedExpr = '((SK)K)'

  it('pretty prints a valid expression',
    () => assert.deepStrictEqual(prettyPrint(expr), printedExpr)
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
