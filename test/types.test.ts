import {
  arrow,
  arrows,
  mkTypeVar,
  typesLitEq,
  inferType
} from '../lib/types'

import { expect } from 'chai'
import { describe, it } from 'mocha'
import { UntypedLambda, mkUntypedAbs, mkVar } from '../lib/lambda'
import { nt } from '../lib/nonterminal'
import { typedTermsLitEq } from '../lib/typedLambda'
import { parseType, parseTypedLambda } from '../lib'

describe('type construction and equivalence', () => {
  const t1 = arrows(mkTypeVar('a'), mkTypeVar('b'), mkTypeVar('c'))
  const t2 = arrows(mkTypeVar('a'), mkTypeVar('b'), mkTypeVar('d'))
  const t3 = arrows(mkTypeVar('d'), mkTypeVar('e'), mkTypeVar('f'))

  it('recursively checks for literal type equivalence', () => {
    expect(typesLitEq(t1, t1)).to.equal(true)
    expect(typesLitEq(t1, t2)).to.equal(false)
    expect(typesLitEq(t1, t3)).to.equal(false)
    expect(typesLitEq(t2, t3)).to.equal(false)
    expect(typesLitEq(t1, t3)).to.equal(false)
  })

  it('associates type construction to the right', () => {
    expect(
      typesLitEq(
        arrows(mkTypeVar('a'), mkTypeVar('b'), mkTypeVar('c')),
        arrow(mkTypeVar('a'), arrow(mkTypeVar('b'), mkTypeVar('c')))
      )
    ).to.equal(true)
  })
})

describe('type inference', () => {
  it('infers the type of the I combinator', () => {
    const [termI, typeofI] = inferType(mkUntypedAbs('x', mkVar('x')))
    const [, parsedTypedI] = parseTypedLambda('λx:a.x')
    const [, parsedIType] = parseType('a→a')

    expect(typedTermsLitEq(termI, parsedTypedI)).to.equal(true)
    expect(typesLitEq(typeofI, parsedIType)).to.equal(true)
  })

  it('infers the type of the K combinator', () => {
    const [termK, typeofK] = inferType(
      mkUntypedAbs('x',
        mkUntypedAbs('y',
          mkVar('x')))
    )
    const [, parsedTypedK] = parseTypedLambda('λx:a.λy:b.x')
    const [, parsedKType] = parseType('a→b→a')

    expect(typedTermsLitEq(termK, parsedTypedK)).to.equal(true)
    expect(typesLitEq(typeofK, parsedKType)).to.equal(true)
  })

  it('infers the type of the S combinator', () => {
    const [termS, typeofS] = inferType(
      mkUntypedAbs('x',
        mkUntypedAbs('y',
          mkUntypedAbs('z',
            nt(
              nt(mkVar('x'), mkVar('z')),
              nt(mkVar('y'), mkVar('z')))
          )
        )
      ))

    const [, parsedTypedS] = parseTypedLambda('λx:a→b→c.λy:a→b.λz:a.xz(yz)')
    const [, parsedSType] = parseType('(a→b→c)→(a→b)→a→c')

    expect(typedTermsLitEq(termS, parsedTypedS)).to.equal(true)
    expect(typesLitEq(typeofS, parsedSType)).to.equal(true)
  })

  it('succeeds at inferring the type of λx.λy.xy', () => {
    const [termT, typeofT] = inferType(
      mkUntypedAbs('x', mkUntypedAbs('y', nt(mkVar('x'), mkVar('y'))))
    )

    const [, parsedTypedT] = parseTypedLambda('λx:a→b.λy:a.xy')
    const [, parsedTType] = parseType('(a→b)→(a→b)')

    expect(typedTermsLitEq(termT, parsedTypedT)).to.equal(true)
    expect(typesLitEq(typeofT, parsedTType)).to.equal(true)
  })

  it('fails to infer type of λx.xx', () => {
    expect(() => inferType(mkUntypedAbs('x', nt(mkVar('x'), mkVar('x')))))
      .to.throw(/type mismatch/)
  })

  it('fails at inferring the type λx.λy.(xy)x', () => {
    expect(() => inferType(mkUntypedAbs('x',
      mkUntypedAbs('y',
        nt<UntypedLambda>(
          nt<UntypedLambda>(
            mkVar('x'),
            mkVar('y')),
          mkVar('x')))))
    ).to.throw(/type mismatch/)
  })
})
