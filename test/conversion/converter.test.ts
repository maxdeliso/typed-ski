import {
  mkVar,
  reduceSKI,
  predLambda,
  UnChurch,
  ChurchN,
  prettyPrintUntypedLambda
} from '../../lib'
import { Lambda, convertLambda } from '../../lib/conversion/converter'
import { nt } from '../../lib/nonterminal'
import { I, S, K } from '../../lib/ski/terminal'
import { UpTo } from '../ski/church.test'
import { apply } from '../../lib/ski/expression'
import { describe, it } from 'mocha'
import { expect } from 'chai'

describe('Lambda conversion', () => {
  const mkAbs = (name: string, body: Lambda): Lambda => ({
    kind: 'lambda-abs',
    name,
    body
  })

  const id = mkAbs('x', mkVar('x'))

  const konst = mkAbs('x', mkAbs('y', mkVar('x')))

  const flip = mkAbs('x', mkAbs('y', nt(mkVar('y'), mkVar('x'))))

  it('should convert λx.x to I', () => {
    expect(convertLambda(id)).to.deep.equal(I)
  })

  it('should convert λx.λy.x to something that acts like K', () => {
    expect(reduceSKI(apply(convertLambda(konst), S, K))).to.deep.equal(S)
  })

  it('should convert λx.λy.y x to something that acts like T', () => {
    expect(reduceSKI(apply(convertLambda(flip), S, K))).to.deep.equal(nt(K, S))
  })

  it(`should convert ${prettyPrintUntypedLambda(predLambda)} to pred`, () => {
    UpTo(8).forEach(n =>
      expect(
        UnChurch(reduceSKI(apply(convertLambda(predLambda), ChurchN(n))))
      ).to.deep.equal(Math.max(n - 1, 0))
    )
  })
})
