import { arrow, arrows, mkTypeVar, mono, typesEqual } from '../lib/types'

import { expect } from 'chai'
import { describe, it } from 'mocha'

describe('Type construction', () => {
  it('determines mono-types correctly', () => {
    expect(mono(mkTypeVar('a'))).to.equal(true)
    expect(mono(arrow(mkTypeVar('a'), mkTypeVar('b')))).to.equal(false)
  })

  const t1 = arrows(mkTypeVar('a'), mkTypeVar('b'), mkTypeVar('c'))
  const t2 = arrows(mkTypeVar('a'), mkTypeVar('b'), mkTypeVar('d'))

  it('recursively checks for type equivalence', () => {
    expect(typesEqual(t1, t1)).to.equal(true)
    expect(typesEqual(t1, t2)).to.equal(false)
  })

  it('associates type construction to the right', () => {
    expect(
      typesEqual(
        arrows(mkTypeVar('a'), mkTypeVar('b'), mkTypeVar('c')),
        arrow(mkTypeVar('a'), arrow(mkTypeVar('b'), mkTypeVar('c')))
      )
    ).to.equal(true)
  })
})