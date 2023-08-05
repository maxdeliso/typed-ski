import { mkVar } from '../lib/lambda'
import { nt } from '../lib/nonterminal'
import { mkTypedAbs, typecheck } from '../lib/typedLambda'
import { arrow, arrows, mkTypeVar, typesEqual } from '../lib/types'

import { expect } from 'chai'
import { describe, it } from 'mocha'

describe('the type checker', () => {
  it('typechecks the I combinator', () => {
    // λx : a . x ≡ I : a -> a
    const typedI = mkTypedAbs('x', mkTypeVar('a'), mkVar('x'))
    const typeofI = typecheck(typedI)
    const expectedTy = arrow(mkTypeVar('a'), mkTypeVar('a'))
    expect(typesEqual(typeofI, expectedTy)).to.equal(true)
  })

  it('typechecks the K combinator', () => {
    // λx : a . λy : b . x ≡ K : a -> b -> a
    const typedK =
      mkTypedAbs('x', mkTypeVar('a'), // λx : a
        mkTypedAbs('y', mkTypeVar('b'), // λy : b
          mkVar('x') // x
        )
      )
    const typeofK = typecheck(typedK)
    const expectedTy = arrows(mkTypeVar('a'), mkTypeVar('b'), mkTypeVar('a'))

    expect(typesEqual(typeofK, expectedTy)).to.equal(true)
  })

  it('typechecks the S combinator', () => {
    // λx : (a -> b -> c) . λy : (a -> b) . λz : a . xz(yz)
    // ≡ S : (a -> b -> c) -> (a -> b) -> (a -> c)
    const typedS =
      mkTypedAbs(
        'x', // a -> b -> c
        arrows(mkTypeVar('a'), mkTypeVar('b'), mkTypeVar('c')),
        mkTypedAbs(
          'y', // a -> b
          arrow(mkTypeVar('a'), mkTypeVar('b')),
          mkTypedAbs(
            'z', // a
            mkTypeVar('a'),
            nt(
              nt(mkVar('x'), mkVar('z')),
              nt(mkVar('y'), mkVar('z'))
            )
          )
        )
      )

    // (a -> b -> c) -> (a -> b) -> a -> c
    const expectedTy = arrows(
      arrows(mkTypeVar('a'), mkTypeVar('b'), mkTypeVar('c')),
      arrows(mkTypeVar('a'), mkTypeVar('b')),
      arrows(mkTypeVar('a'), mkTypeVar('c'))
    )

    const typeofS = typecheck(typedS)

    expect(typesEqual(typeofS, expectedTy)).to.equal(true)
  })
})
