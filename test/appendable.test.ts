import { K, S } from '../lib/terminal'
import { nt } from '../lib/nonterminal'
import { expect } from 'chai'
import { Appendable } from '../lib/appendable'

describe('appendable expressions', () => {
  it('append a pair of terminals into a single non-terminal', () => {
    const appendable = new Appendable()
    appendable.append(S)
    appendable.append(K)
    appendable.flatten()
    expect(appendable.flatten()).to.deep.equal(nt(S, K))
  })

  it('append undefined and a terminal to yield that terminal', () => {
    const appendable = new Appendable()
    appendable.append(S)
    expect(appendable.flatten()).to.deep.equal(S)
  })

  it('fills in undefined holes on the left side of a non-terminal', () => {
    const appendable = new Appendable()
    appendable.append(nt(undefined, undefined))
    appendable.append(S)
    appendable.append(K)
    expect(appendable.flatten()).to.deep.equal(nt(S, K))
  })
})
