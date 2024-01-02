import { Expression, prettyPrint } from '../lib/expression'
import { nt } from '../lib/nonterminal'
import { parse, ParseError, parseType, parseTypedLambda } from '../lib/parser'
import { S, K, I } from '../lib/terminal'
import {
  mkTypedAbs,
  typedTermsLitEq
} from '../lib/typedLambda'
import { mkVar } from '../lib/lambda'
import {
  arrow,
  mkTypeVar,
  typesLitEq,
  arrows
} from '../lib/types'

import { assert, expect } from 'chai'
import { describe, it } from 'mocha'

describe('parse', () => {
  const firstLiteral = '(I(SK))'
  const secondLiteral = '(((((SK)I)S)K)I)'

  const assertPrintedParsedPair = (a: Expression, b: Expression): void => {
    assert.deepStrictEqual(prettyPrint(a), prettyPrint(b))
    assert.deepStrictEqual(a, b)
  }

  it(`should parse ${firstLiteral} and variations`, () => {
    const expectedISK = nt<Expression>(I, nt(S, K))
    const parsedISK = parse(firstLiteral)

    assertPrintedParsedPair(parsedISK, expectedISK)
  })

  it('should fail to parse an unrecognized literal', () => {
    expect(() => parse('(Q')).to.throw(ParseError, /unrecognized/)
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

    assertPrintedParsedPair(parse(secondLiteral), expected)
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

    assert.deepStrictEqual(printed, reprinted)
    assert.deepStrictEqual(parsed, reparsed)
  }

  it('should reparse complicated expressions', () => {
    assertReparse('S(K(SKK))SI')
    assertReparse('SK(SKK)SI')
    assertReparse('SKI')
    assertReparse('(IIII)')
  })

  it('parses a single term application', () => {
    const parseInput = 'xy'
    const [parsedLit, term] = parseTypedLambda(parseInput)

    const parsed = nt(mkVar('x'), mkVar('y'))

    expect(parsedLit).to.equal(parseInput)
    expect(typedTermsLitEq(term, parsed)).to.equal(true)
  })

  it('parses juxstaposed terms', () => {
    const parseInput = 'xz(yz)'
    const [parsedLit, term] = parseTypedLambda(parseInput)

    const parsed = nt(nt(mkVar('x'), mkVar('z')), nt(mkVar('y'), mkVar('z')))

    expect(parsedLit).to.equal(parseInput)
    expect(typedTermsLitEq(term, parsed)).to.equal(true)
  })

  it('parses the type a→b', () => {
    const parseInput = 'a→b'
    const [typeLit, type] = parseType(parseInput)

    expect(typeLit).to.equal(parseInput)
    expect(typesLitEq(type, arrow(mkTypeVar('a'), mkTypeVar('b'))))
  })

  it('parses the type a→b→c', () => {
    const parseInput = 'a→b→c'
    const [typeLit, type] = parseType(parseInput)

    const expectedTy = arrow(
      mkTypeVar('a'),
      arrow(mkTypeVar('b'), mkTypeVar('c'))
    )

    expect(typeLit).to.equal(parseInput)
    expect(typesLitEq(type, expectedTy)).to.equal(true)
  })

  it('parses the type (a→b)→a→b', () => {
    const parseInput = '(a→b)→a→b'
    const [typeLit, type] = parseType(parseInput)

    const expectedTy =
      arrow(
        arrow(mkTypeVar('a'), mkTypeVar('b')),
        arrow(mkTypeVar('a'), mkTypeVar('b')))

    expect(typeLit).to.equal(parseInput)
    expect(typesLitEq(type, expectedTy)).to.equal(true)
  })

  it('parses the type a→b→a→b', () => {
    const parseInput = 'a→b→a→b'
    const [typeLit, type] = parseType(parseInput)

    const expectedTy =
      arrows(
        mkTypeVar('a'),
        mkTypeVar('b'),
        mkTypeVar('a'),
        mkTypeVar('b'))

    expect(typeLit).to.equal(parseInput)
    expect(typesLitEq(type, expectedTy)).to.equal(true)
  })

  it('parses λx:a.xx', () => {
    const parseInput = 'λx:a.xx'
    const [inputLit, term] = parseTypedLambda(parseInput)

    const parsed =
      mkTypedAbs('x',
        mkTypeVar('a'),
        nt(mkVar('x'), mkVar('x')))

    expect(inputLit).to.equal(parseInput)
    expect(typedTermsLitEq(term, parsed)).to.equal(true)
  })

  it('parses a typed lambda expression corresponding to K', () => {
    const parseInput = 'λx:a.λy:b.x'
    const [inputLit, term] = parseTypedLambda(parseInput)

    const parsed =
      mkTypedAbs('x',
        mkTypeVar('a'),
        mkTypedAbs('y',
          mkTypeVar('b'),
          mkVar('x')))

    expect(inputLit).to.equal(parseInput)
    expect(typedTermsLitEq(term, parsed)).to.equal(true)
  })

  it('parses a typed lambda expression corresponding to S', () => {
    const parseInput = 'λx:a→b→c.λy:a→b.λz:a.xz(yz)'
    const [parsedLit, term] = parseTypedLambda(parseInput)

    const parsed =
      mkTypedAbs('x',
        arrows(mkTypeVar('a'), mkTypeVar('b'), mkTypeVar('c')),
        mkTypedAbs('y',
          arrow(mkTypeVar('a'), mkTypeVar('b')),
          mkTypedAbs('z', mkTypeVar('a'),
            nt(nt(mkVar('x'), mkVar('z')), nt(mkVar('y'), mkVar('z'))))))

    expect(parsedLit).to.equal(parseInput)
    expect(typedTermsLitEq(term, parsed)).to.equal(true)
  })

  it('fails to parse missing variable', () => {
    expect(() => parseTypedLambda('λ:a→b.x'))
      .to.throw(ParseError, /failed to parse variable/)
  })

  it('fails to parse an incomplete type', () => {
    expect(() => parseTypedLambda('λx:a→.x'))
      .to.throw(ParseError, /failed to parse variable/)
  })

  it('fails to parse missing term', () => {
    expect(() => parseTypedLambda('λx:a→b.'))
      .to.throw(ParseError, /expected a term/)
  })
})
