import { describe, it } from "../util/test_shim.ts";
import assert from "node:assert/strict";

import { Y } from "../util/combinators.ts";
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
  J,
  K,
  LtU8,
  ReadOne,
  S,
  SPrime,
  V,
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

describe("parseSKI", () => {
  const firstLiteral = "(I(SK))";
  const secondLiteral = "(((((SK)I)S)K)I)";

  const assertPrintedParsedPair = (
    a: SKIExpression,
    b: SKIExpression,
  ): void => {
    assert.deepStrictEqual(unparseSKI(a), unparseSKI(b));
    assert.deepStrictEqual(a, b);
  };

  it(`should parse ${firstLiteral} and variations`, () => {
    const expectedISK = apply(I, apply(S, K));
    const parsedISK = parseSKI(firstLiteral);

    assertPrintedParsedPair(parsedISK, expectedISK);
  });

  it("should fail to parse an unrecognized literal", () => {
    assert.throws(() => parseSKI("(Z"), {
      message: /unexpected token/,
    });
  });

  it(`should parse ${secondLiteral} and variations`, () => {
    const expected = apply(apply(apply(apply(apply(S, K), I), S), K), I);

    assertPrintedParsedPair(parseSKI(secondLiteral), expected);
  });

  it("should parse adjacent chars associating to the left", () => {
    assert.deepStrictEqual(parseSKI("SKI"), parseSKI("(SK)I"));
    assert.deepStrictEqual(parseSKI("(SK)I"), parseSKI("((SK)I)"));

    assert.notDeepStrictEqual(parseSKI("SKI"), parseSKI("S(KI)"));
  });

  it("should fail to parse mismatched parens", () => {
    assert.throws(() => parseSKI("(())("), { message: /unexpected token/ });
    assert.throws(() => parseSKI("("), { message: /unexpected token/ });
    assert.throws(() => parseSKI("()())"), { message: /unexpected token/ });
  });

  it("should parse the Y combinator", () => {
    assertReparse(unparseSKI(Y));
  });

  it("should reparse complicated expressions", () => {
    assertReparse("S(K(SKK))SI");
    assertReparse("SK(SKK)SI");
    assertReparse("SKI");
    assertReparse("(IIII)");
  });

  it("should parse mixed-case input correctly", () => {
    // Lowercase letters should be accepted, and converted to uppercase.
    const upper = parseSKI("SKI");
    const lower = parseSKI("ski");
    const mixed = parseSKI("sKi");
    assert.deepStrictEqual(upper, lower);
    assert.deepStrictEqual(upper, mixed);
  });

  it("should parse IO terminals", () => {
    const parsed = parseSKI(",.");
    const expected = apply(ReadOne, WriteOne);
    assert.deepStrictEqual(parsed, expected);
    assertReparse(",.");
  });

  it("should parse B and C terminals", () => {
    assert.deepStrictEqual(parseSKI("B"), B);
    assert.deepStrictEqual(parseSKI("C"), C);

    const parsed = parseSKI("BCI");
    const expected = apply(apply(B, C), I);
    assert.deepStrictEqual(parsed, expected);
    assertReparse("BCI");
  });

  it("should parse Turner prime terminals", () => {
    assert.deepStrictEqual(parseSKI("P"), SPrime);
    assert.deepStrictEqual(parseSKI("Q"), BPrime);
    assert.deepStrictEqual(parseSKI("R"), CPrime);

    const parsed = parseSKI("PQR");
    const expected = apply(apply(SPrime, BPrime), CPrime);
    assert.deepStrictEqual(parsed, expected);
    assertReparse("PQR");
  });

  it("should parse mixed-case B and C terminals", () => {
    const upper = parseSKI("BCI");
    const lower = parseSKI("bci");
    const mixed = parseSKI("bCi");
    assert.deepStrictEqual(upper, lower);
    assert.deepStrictEqual(upper, mixed);
  });

  it("should place IO terminals in correct tree locations", () => {
    const parsed = parseSKI(".,I");
    const expected = apply(apply(WriteOne, ReadOne), I);
    assert.deepStrictEqual(parsed, expected);

    const nested = parseSKI("(.I),");
    const nestedExpected = apply(apply(WriteOne, I), ReadOne);
    assert.deepStrictEqual(nested, nestedExpected);
  });

  it("should parse input with extra whitespace", () => {
    const noSpaces = parseSKI("SKI");
    const withSpaces = parseSKI("S k I");
    assert.deepStrictEqual(withSpaces, noSpaces);
  });

  it("should parse J/V immediates with decimal suffixes", () => {
    assert.deepStrictEqual(parseSKI("J0"), J(0));
    assert.deepStrictEqual(parseSKI("j12"), J(12));
    assert.deepStrictEqual(parseSKI("V0"), V(0));
    assert.deepStrictEqual(parseSKI("v3"), V(3));
    assertReparse("J12");
    assertReparse("V3");
    assertReparse("(J2(V1#u8(65)))");
  });

  it("should keep plain L mapped to ltU8", () => {
    assert.deepStrictEqual(parseSKI("L"), LtU8);
    assert.deepStrictEqual(parseSKI("l"), LtU8);
  });

  it("should parse a complex expression with mixed-case and spaces", () => {
    const expr1 = parseSKI(" s ( K ( s I i ) ) ");
    const expr2 = parseSKI("S(K(SII))");
    assert.deepStrictEqual(expr1, expr2);
  });

  it("should fail on invalid mixed-case literal", () => {
    assert.throws(() => parseSKI("sX"), { message: /unexpected extra/ });
    assert.throws(() => parseSKI("Xsi"), { message: /unexpected token/ });
  });

  it("should fail on #u8 literals out of range", () => {
    assert.throws(() => parseSKI("#u8(256)"), {
      message: /#u8 value must be 0..255/,
    });
  });

  it("should fail on malformed J/V immediates", () => {
    assert.throws(() => parseSKI("J"), {
      message: /decimal suffix/,
    });
    assert.throws(() => parseSKI("V"), {
      message: /decimal suffix/,
    });
    assert.throws(() => parseSKI("J256"), {
      message: /must be 0\.\.255/,
    });
  });
});
