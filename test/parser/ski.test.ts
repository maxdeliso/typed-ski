import { assert, expect } from "chai";

import { Y } from "../../lib/consts/combinators.ts";
import { ParseError } from "../../lib/parser/parseError.ts";
import { parseSKI } from "../../lib/parser/ski.ts";
import {
  apply,
  type SKIExpression,
  unparseSKI,
} from "../../lib/ski/expression.ts";
import {
  B,
  BPrime,
  C,
  CPrime,
  I,
  K,
  ReadOne,
  S,
  SPrime,
  WriteOne,
} from "../../lib/ski/terminal.ts";

const assertReparse = (expr: string) => {
  const parsed = parseSKI(expr);
  const printed = unparseSKI(parsed);
  const reparsed = parseSKI(printed);
  const reprinted = unparseSKI(reparsed);

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
    assert.deepStrictEqual(unparseSKI(a), unparseSKI(b));
    assert.deepStrictEqual(a, b);
  };

  await t.step(`should parse ${firstLiteral} and variations`, () => {
    const expectedISK = apply(I, apply(S, K));
    const parsedISK = parseSKI(firstLiteral);

    assertPrintedParsedPair(parsedISK, expectedISK);
  });

  await t.step("should fail to parse an unrecognized literal", () => {
    expect(() => parseSKI("(Z")).to.throw(ParseError, /unexpected token/);
  });

  await t.step(`should parse ${secondLiteral} and variations`, () => {
    const expected = apply(
      apply(
        apply(
          apply(
            apply(S, K),
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
    assertReparse(unparseSKI(Y));
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

  await t.step("should parse IO terminals", () => {
    const parsed = parseSKI(",.");
    const expected = apply(ReadOne, WriteOne);
    assert.deepStrictEqual(parsed, expected);
    assertReparse(",.");
  });

  await t.step("should parse B and C terminals", () => {
    assert.deepStrictEqual(parseSKI("B"), B);
    assert.deepStrictEqual(parseSKI("C"), C);

    const parsed = parseSKI("BCI");
    const expected = apply(apply(B, C), I);
    assert.deepStrictEqual(parsed, expected);
    assertReparse("BCI");
  });

  await t.step("should parse Turner prime terminals", () => {
    assert.deepStrictEqual(parseSKI("P"), SPrime);
    assert.deepStrictEqual(parseSKI("Q"), BPrime);
    assert.deepStrictEqual(parseSKI("R"), CPrime);

    const parsed = parseSKI("PQR");
    const expected = apply(apply(SPrime, BPrime), CPrime);
    assert.deepStrictEqual(parsed, expected);
    assertReparse("PQR");
  });

  await t.step("should parse mixed-case B and C terminals", () => {
    const upper = parseSKI("BCI");
    const lower = parseSKI("bci");
    const mixed = parseSKI("bCi");
    assert.deepStrictEqual(upper, lower);
    assert.deepStrictEqual(upper, mixed);
  });

  await t.step("should place IO terminals in correct tree locations", () => {
    const parsed = parseSKI(".,I");
    const expected = apply(apply(WriteOne, ReadOne), I);
    assert.deepStrictEqual(parsed, expected);

    const nested = parseSKI("(.I),");
    const nestedExpected = apply(apply(WriteOne, I), ReadOne);
    assert.deepStrictEqual(nested, nestedExpected);
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
