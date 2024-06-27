import {
  mkUntypedAbs,
  mkVar,
  prettyPrintUntypedLambda,
  typelessApp
} from '../../lib'
import { parseLambda } from '../../lib/parser/untyped'
import { expect } from 'chai'

describe('parseUntypedLambda()', () => {
  it('parses application', () => {
    const input = 'ab'
    const [lit, term] = parseLambda(input)
    expect(lit).to.equal(input)
    expect(term).to.deep.equal(typelessApp(mkVar('a'), mkVar('b')))
  })

  it('parses application with parens', () => {
    const input = '(ab)'
    const [lit, term] = parseLambda(input)
    expect(lit).to.equal(input)
    expect(term).to.deep.equal(typelessApp(mkVar('a'), mkVar('b')))
  })

  it('parses an unbalanced triplet of vars', () => {
    const input = 'a(bc)'
    const [lit, term] = parseLambda(input)
    expect(lit).to.equal(input)
    expect(term).to.deep.equal(
      typelessApp(mkVar('a'), typelessApp(mkVar('b'), mkVar('c')))
    )
  })

  it('parses a var applied to a lambda', () => {
    const input = 'a(λb.b(aa))'
    const [lit, term] = parseLambda(input)
    expect(lit).to.equal(input)

    expect(term).to.deep.equal(
      typelessApp(mkVar('a'),
        typelessApp(mkUntypedAbs('b',
          typelessApp(mkVar('b'), typelessApp(mkVar('a'), mkVar('a'))))
        )
      ))
  })

  it('parses pred', () => {
    const input = 'λn.λf.λx.n(λg.λh.h(gf))(λu.x)(λu.u)'

    // λn.λf.λx.n(λg.λh.h(gf))(λu.x)(λu.u)
    const predLambda =
          // λn.λf.λx.
          mkUntypedAbs('n', mkUntypedAbs('f', mkUntypedAbs('x',
          // n(λg.λh.h(gf))(λu.x)(λu.u)
            typelessApp(
              mkVar('n'), // n
              mkUntypedAbs('g', mkUntypedAbs('h', // λg.λh.
                typelessApp(
                  mkVar('h'), typelessApp(mkVar('g'), mkVar('f'))))
              ), // h(gf)
              mkUntypedAbs('u', mkVar('x')), // (λu.x)
              mkUntypedAbs('u', mkVar('u')) // (λu.u)
            )
          )))

    const [, term] = parseLambda(input)
    expect(term).to.deep.equal(predLambda)
    const [, reparsed] = parseLambda(prettyPrintUntypedLambda(term))
    expect(reparsed).to.deep.equal(predLambda)
  })
})
