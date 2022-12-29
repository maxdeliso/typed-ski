import { Expression, prettyPrint } from '../lib/expression'
import { nt } from '../lib/nonterminal'
import { parse, ParseError } from '../lib/parser'
import { I, K, S } from '../lib/terminal'

import { assert, expect } from 'chai'
import { describe, it } from 'mocha'

const firstLiteral = '(I(SK))'
const secondLiteral = '(((((SK)I)S)K)I)'

describe('parse', () => {
  it(`should parse ${firstLiteral} and variations`, () => {
    const expected = nt<Expression>(I, nt(S, K))

    assert.deepStrictEqual(parse(firstLiteral), expected)
    assert.deepStrictEqual(parse('I(SK)'), expected)
  })

  it(`should parse ${secondLiteral} and variations`, () => {
    const expected =
      nt<Expression>(
        nt<Expression>(
          nt<Expression>(
            nt<Expression>(
              nt(S, K), I
            ),
            S),
          K),
        I)

    assert.deepStrictEqual(parse(secondLiteral), expected)
    assert.deepStrictEqual(parse('SKISKI'), expected)
  })

  it('should parse adjacent chars associating to the left', () => {
    assert.deepStrictEqual(parse('SKI'), parse('(SK)I'))
    assert.deepStrictEqual(parse('(SK)I'), parse('((SK)I)'))

    assert.notDeepEqual(parse('SKI'), parse('S(KI)'))
  })

  it('should fail to parse mismatched parens', () => {
    expect(() => parse('(())(')).to.throw(ParseError, /mismatched/)
    expect(() => parse('(')).to.throw(ParseError, /mismatched/)
    expect(() => parse('()())')).to.throw(ParseError, /mismatched/)
  })

  const assertReparse = (expr: string) => {
    const parsed = parse(expr)
    const printed = prettyPrint(parsed)
    const reparsed = parse(printed)
    const reprinted = prettyPrint(reparsed)

    assert.deepStrictEqual(parsed, reparsed)
    assert.deepStrictEqual(printed, reprinted)
  }

  it('should reparse complicated expressions', () => {
    assertReparse('S(K(SKK))SI')
    assertReparse('SK(SKK)SI')
    assertReparse('SKI')
    assertReparse('(IIII)')
  })
})
