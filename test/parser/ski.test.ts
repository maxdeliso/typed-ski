import { cons } from '../../lib/cons.ts';
import { Y } from '../../lib/consts/combinators.ts';
import { ParseError } from '../../lib/parser/parseError.ts';
import { parseSKI } from '../../lib/parser/ski.ts';
import { SKIExpression, prettyPrint } from '../../lib/ski/expression.ts';
import { S, K, I } from '../../lib/ski/terminal.ts';

import { assert, expect } from 'chai';

describe('parseSKI', () => {
  const firstLiteral = '(I(SK))';
  const secondLiteral = '(((((SK)I)S)K)I)';

  const assertPrintedParsedPair = (
    a: SKIExpression,
    b: SKIExpression
  ): void => {
    assert.deepStrictEqual(prettyPrint(a), prettyPrint(b));
    assert.deepStrictEqual(a, b);
  };

  it(`should parse ${firstLiteral} and variations`, () => {
    const expectedISK = cons<SKIExpression>(I, cons(S, K));
    const parsedISK = parseSKI(firstLiteral);

    assertPrintedParsedPair(parsedISK, expectedISK);
  });

  it('should fail to parse an unrecognized literal', () => {
    expect(() => parseSKI('(Q')).to.throw(ParseError, /unrecognized/);
  });

  it(`should parse ${secondLiteral} and variations`, () => {
    const expected =
      cons<SKIExpression>(
        cons<SKIExpression>(
          cons<SKIExpression>(
            cons<SKIExpression>(
              cons(S, K), I
            ),
            S),
          K),
        I);

    assertPrintedParsedPair(parseSKI(secondLiteral), expected);
  });

  it('should parse adjacent chars associating to the left', () => {
    assert.deepStrictEqual(parseSKI('SKI'), parseSKI('(SK)I'));
    assert.deepStrictEqual(parseSKI('(SK)I'), parseSKI('((SK)I)'));

    assert.notDeepEqual(parseSKI('SKI'), parseSKI('S(KI)'));
  });

  it('should fail to parse mismatched parens', () => {
    expect(() => parseSKI('(())(')).to.throw(ParseError, /mismatched/);
    expect(() => parseSKI('(')).to.throw(ParseError, /mismatched/);
    expect(() => parseSKI('()())')).to.throw(ParseError, /mismatched/);
  });

  it('should parse the Y combinator', () => {
    assertReparse(prettyPrint(Y));
  });

  const assertReparse = (expr: string) => {
    const parsed = parseSKI(expr);
    const printed = prettyPrint(parsed);
    const reparsed = parseSKI(printed);
    const reprinted = prettyPrint(reparsed);

    assert.deepStrictEqual(printed, reprinted);
    assert.deepStrictEqual(parsed, reparsed);
  };

  it('should reparse complicated expressions', () => {
    assertReparse('S(K(SKK))SI');
    assertReparse('SK(SKK)SI');
    assertReparse('SKI');
    assertReparse('(IIII)');
  });
});
