import { S, K, I } from '../lib/terminal'
import { nt } from '../lib/nonterminal'
import { expect } from 'chai'
import { Appendable } from '../lib/appendable'
import { Expression } from '../lib'

describe('appendable expressions', () => {
  it('append a pair of terminals into a single non-terminal', () => {
    const app = new Appendable()
    app.appendSymbol(S)
    app.appendSymbol(K)
    app.flatten()
    expect(app.flatten()).to.deep.equal(nt(S, K))
  })

  it('append undefined and a terminal to yield that terminal', () => {
    const app = new Appendable()
    app.appendSymbol(S)
    expect(app.flatten()).to.deep.equal(S)
  })

  it('fills in undefined holes on the left side of a non-terminal', () => {
    const app = new Appendable()
    app.appendEmptyBranch()
    app.appendSymbol(S)
    app.appendSymbol(K)
    expect(app.flatten()).to.deep.equal(nt(S, K))
  })

  it('throws when attempting to flatten an incomplete expr', () => {
    const app = new Appendable()
    app.appendEmptyBranch()
    expect(() => app.flatten()).to.throw('expression undefined (hole)')
  })

  it('successfully parses a tree which hangs to the right', () => {
    const app = new Appendable()
    app.appendEmptyBranch()
    app.appendEmptyBranch()
    app.appendEmptyBranch()
    app.appendSymbol(S)
    app.appendSymbol(K)
    app.appendEmptyBranch()
    app.appendSymbol(I)
    app.appendSymbol(S)
    app.appendEmptyBranch()
    app.appendSymbol(K)
    app.appendSymbol(I)
    expect(app.flatten()).to.deep.equal(
      nt<Expression>(
        nt<Expression>(
          nt<Expression>(
            S,
            K
          ),
          nt<Expression>(
            I,
            S
          )
        ),
        nt<Expression>(
          K,
          I
        )
      )
    )
  })

  it('successfully parses a mixed tree', () => {
    const app = new Appendable()
    app.appendEmptyBranch()
    app.appendSymbol(S)
    app.appendSymbol(K)
    app.appendEmptyBranch()
    app.appendSymbol(I)
    app.appendSymbol(S)
    app.appendEmptyBranch()
    app.appendSymbol(K)
    app.appendSymbol(I)
    expect(app.flatten()).to.deep.equal(
      nt<Expression>(
        nt<Expression>(
          nt<Expression>(
            S,
            K
          ),
          nt<Expression>(
            I,
            S
          )
        ),
        nt<Expression>(
          K,
          I
        )
      )
    )
  })
})
