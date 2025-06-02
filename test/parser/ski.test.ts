import { assert, expect } from "npm:chai";

import { cons } from "../../lib/cons.ts";
import { Y } from "../../lib/consts/combinators.ts";
import { ParseError } from "../../lib/parser/parseError.ts";
import { parseSKI } from "../../lib/parser/ski.ts";
import { prettyPrint, type SKIExpression } from "../../lib/ski/expression.ts";
import { I, K, S } from "../../lib/ski/terminal.ts";

const assertReparse = (expr: string) => {
  const parsed = parseSKI(expr);
  const printed = prettyPrint(parsed);
  const reparsed = parseSKI(printed);
  const reprinted = prettyPrint(reparsed);

  assert.deepStrictEqual(printed, reprinted);
  assert.deepStrictEqual(parsed, reparsed);
};

Deno.test("parseSKI", async (t) => {
  const firstLiteral = "(I(SK))";
  const secondLiteral = "(((((SK)I)S)K)I)";

  const assertPrintedParsedPair = (
    a: SKIExpression,
    b: SKIExpression,
  ): void => {
    assert.deepStrictEqual(prettyPrint(a), prettyPrint(b));
    assert.deepStrictEqual(a, b);
  };

  await t.step(`should parse ${firstLiteral} and variations`, () => {
    const expectedISK = cons<SKIExpression>(I, cons(S, K));
    const parsedISK = parseSKI(firstLiteral);

    assertPrintedParsedPair(parsedISK, expectedISK);
  });

  await t.step("should fail to parse an unrecognized literal", () => {
    expect(() => parseSKI("(Q")).to.throw(ParseError, /unexpected token/);
  });

  await t.step(`should parse ${secondLiteral} and variations`, () => {
    const expected = cons<SKIExpression>(
      cons<SKIExpression>(
        cons<SKIExpression>(
          cons<SKIExpression>(
            cons(S, K),
            I,
          ),
          S,
        ),
        K,
      ),
      I,
    );

    assertPrintedParsedPair(parseSKI(secondLiteral), expected);
  });

  await t.step("should parse adjacent chars associating to the left", () => {
    assert.deepStrictEqual(parseSKI("SKI"), parseSKI("(SK)I"));
    assert.deepStrictEqual(parseSKI("(SK)I"), parseSKI("((SK)I)"));

    assert.notDeepEqual(parseSKI("SKI"), parseSKI("S(KI)"));
  });

  await t.step("should fail to parse mismatched parens", () => {
    expect(() => parseSKI("(())(")).to.throw(ParseError, /unexpected token/);
    expect(() => parseSKI("(")).to.throw(ParseError, /unexpected token/);
    expect(() => parseSKI("()())")).to.throw(ParseError, /unexpected token/);
  });

  await t.step("should parse the Y combinator", () => {
    assertReparse(prettyPrint(Y));
  });

  await t.step("should reparse complicated expressions", () => {
    assertReparse("S(K(SKK))SI");
    assertReparse("SK(SKK)SI");
    assertReparse("SKI");
    assertReparse("(IIII)");
  });

  await t.step("should parse mixed-case input correctly", () => {
    // Lowercase letters should be accepted, and converted to uppercase.
    const upper = parseSKI("SKI");
    const lower = parseSKI("ski");
    const mixed = parseSKI("sKi");
    assert.deepStrictEqual(upper, lower);
    assert.deepStrictEqual(upper, mixed);
  });

  await t.step("should parse input with extra whitespace", () => {
    const noSpaces = parseSKI("SKI");
    const withSpaces = parseSKI("S k I");
    assert.deepStrictEqual(withSpaces, noSpaces);
  });

  await t.step(
    "should parse a complex expression with mixed-case and spaces",
    () => {
      const expr1 = parseSKI(" s ( K ( s I i ) ) ");
      const expr2 = parseSKI("S(K(SII))");
      assert.deepStrictEqual(expr1, expr2);
    },
  );

  await t.step("should fail on invalid mixed-case literal", () => {
    expect(() => parseSKI("sX")).to.throw(ParseError, /unexpected extra/);
    expect(() => parseSKI("Xsi")).to.throw(ParseError, /unexpected token/);
  });
});
