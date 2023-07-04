import { Lambda, convertLambda } from '../lib/converter'
import { S, K, I } from '../lib/terminal'
import { reduce } from '../lib/evaluator'
import { apply } from '../lib/expression'
import { nt } from '../lib/nonterminal'

import { expect } from 'chai'
import { describe, it } from 'mocha'

describe('Lambda conversion', () => {
  const mkAbs = (name: string, body: Lambda): Lambda => ({
    kind: 'lambda-abs',
    name,
    body
  })

  const mkVar = (name: string): Lambda => ({
    kind: 'lambda-var',
    name
  })

  const id = mkAbs('x', mkVar('x'))

  const konst = mkAbs('x', mkAbs('y', mkVar('x')))

  const flip = mkAbs('x', mkAbs('y', nt(mkVar('y'), mkVar('x'))))

  it('should convert λx -> x to I', () => {
    expect(convertLambda(id)).to.deep.equal(I)
  })

  it('should convert λx y -> x to something that acts like K', () => {
    expect(reduce(apply(convertLambda(konst), S, K))).to.deep.equal(S)
  })

  it('should convert λx y -> y x to something that acts like T', () => {
    expect(reduce(apply(convertLambda(flip), S, K))).to.deep.equal(nt(K, S))
  })
})
