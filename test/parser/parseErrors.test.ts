import { describe, it } from "../util/test_shim.ts";
import assert from "node:assert/strict";
import { ParseError } from "../../lib/parser/parseError.ts";
import { parseTripLang } from "../../lib/parser/tripLang.ts";
import { parseSystemF } from "../../lib/parser/systemFTerm.ts";
import { parseSKI } from "../../lib/parser/ski.ts";
import { parseArrowTypeNoApp, parseType } from "../../lib/parser/type.ts";
import { parseSystemFType } from "../../lib/parser/systemFType.ts";
import {
  createParserState,
  matchArrow,
  matchCh,
  matchFatArrow,
  parseDefinitionKeyword,
  parseIdentifier,
  parseNumericLiteral,
  skipWhitespace,
} from "../../lib/parser/parserState.ts";
import { parseChain } from "../../lib/parser/chain.ts";
import { createTypedApp } from "../util/ast.ts";
import { parseWithEOF } from "../../lib/parser/eof.ts";

describe("Parser Error Coverage", () => {
  describe("parserState.ts errors", () => {
    it("non-ASCII byte error", () => {
      assert.throws(() => createParserState("hello λ"), {
        message: /non-ASCII byte.*0x/,
      });
    });

    it("expected character but found different", () => {
      assert.throws(
        () => {
          const state = createParserState("abc");
          matchCh(state, "x");
        },
        {
          message: /expected 'x' but found/,
        },
      );
    });

    it("expected character but found EOF", () => {
      assert.throws(
        () => {
          const state = createParserState("");
          matchCh(state, "x");
        },
        {
          message: /expected 'x' but found.*EOF/,
        },
      );
    });

    it("expected arrow but found different", () => {
      assert.throws(
        () => {
          const state = createParserState("abc");
          matchArrow(state);
        },
        {
          message: /expected '->' but found/,
        },
      );
    });

    it("expected fat arrow but found different", () => {
      assert.throws(
        () => {
          const state = createParserState("abc");
          matchFatArrow(state);
        },
        {
          message: /expected '=>' but found/,
        },
      );
    });

    it("expected identifier", () => {
      assert.throws(
        () => {
          const state = createParserState("");
          parseIdentifier(state);
        },
        {
          message: /expected an identifier/,
        },
      );
    });

    it("purely numeric identifier", () => {
      assert.throws(
        () => {
          const state = createParserState("123");
          const wsState = skipWhitespace(state);
          parseIdentifier(wsState);
        },
        {
          message: /not a valid identifier.*purely numeric/,
        },
      );
    });

    it("reserved numeric literal identifier", () => {
      assert.throws(
        () => {
          const state = createParserState("__trip_nat_literal__0");
          parseIdentifier(state);
        },
        {
          message: /reserved for numeric literals/,
        },
      );
    });

    it("expected numeric literal", () => {
      assert.throws(
        () => {
          const state = createParserState("abc");
          parseNumericLiteral(state);
        },
        {
          message: /expected numeric literal/,
        },
      );
    });

    it("expected definition keyword", () => {
      assert.throws(
        () => {
          const state = createParserState("invalid");
          parseDefinitionKeyword(state);
        },
        {
          message: /expected definition keyword/,
        },
      );
    });
  });

  describe("systemFTerm.ts errors", () => {
    it("match requires explicit return type", () => {
      assert.throws(() => parseSystemF("match x { | None => y }"), {
        message: /match requires an explicit return type/,
      });
    });

    it("expected pipe to start match arm", () => {
      assert.throws(() => parseSystemF("match x [T] { None => y }"), {
        message: /expected '\|' to start match arm/,
      });
    });

    it("match arm requires a body", () => {
      // The error occurs when parsing the body term, not when checking bodyLit
      // This is tested indirectly - empty body causes parseSystemFTerm to fail
      assert.throws(() => parseSystemF("match x [T] { | None => }"));
    });

    it("match must declare at least one arm", () => {
      assert.throws(() => parseSystemF("match x [T] { }"), {
        message: /match must declare at least one arm/,
      });
    });

    it("expected 'in' after let binding", () => {
      assert.throws(() => parseSystemF("let x = 1"));
    });

    it("expected character but found EOF (let)", () => {
      // When EOF is reached, it fails trying to parse 'in' as identifier
      assert.throws(() => parseSystemF("let x = 1"), {
        message: /expected an identifier/,
      });
    });

    it("unterminated character literal", () => {
      // The error occurs when trying to match the closing quote
      assert.throws(() => parseSystemF("'a"), {
        message: /expected ''' but found.*EOF/,
      });
    });

    it("empty character literal", () => {
      assert.throws(() => parseSystemF("''"), {
        message: /empty character literal/,
      });
    });

    it("unsupported escape sequence in character literal", () => {
      assert.throws(() => parseSystemF("'\\z'"), {
        message: /unsupported escape sequence.*character literal/,
      });
    });

    it("non-printable ASCII in character literal", () => {
      assert.throws(() => parseSystemF("'\u0001'"), {
        message: /non-printable ASCII in character literal/,
      });
    });

    it("unterminated string literal", () => {
      assert.throws(() => parseSystemF('"hello'), {
        message: /unterminated string literal/,
      });
    });

    it("non-printable ASCII in string literal", () => {
      assert.throws(() => parseSystemF('"\u0001"'), {
        message: /non-printable ASCII in string literal/,
      });
    });

    it("unexpected token while parsing atomic term", () => {
      assert.throws(() => parseSystemF("!x"), {
        message: /unexpected token.*while parsing atomic term/,
      });
    });
  });

  describe("tripLang.ts errors", () => {
    it("data definition must declare at least one constructor", () => {
      assert.throws(() => parseTripLang("module Test\ndata T ="), {
        message: /data definition must declare at least one constructor/,
      });
    });

    it("Unknown definition kind", () => {
      // This shouldn't happen in practice, but we test the error path
      // by checking that invalid keywords are caught
      assert.throws(() => parseTripLang("invalid x = y"), {
        message: /expected definition keyword/,
      });
    });
  });

  describe("eof.ts errors", () => {
    it("unexpected extra input", () => {
      assert.throws(
        () => {
          parseWithEOF("a b", (state) => {
            const [lit, ty, finalState] = parseArrowTypeNoApp(state);
            return [lit, ty, finalState];
          });
        },
        {
          message: /unexpected extra input/,
        },
      );
    });
  });

  describe("type.ts errors", () => {
    it("expected ')' after type expression", () => {
      assert.throws(() => parseType("(a->b"), {
        message: /expected '\)' after type expression/,
      });
    });
  });

  describe("systemFType.ts errors", () => {
    it("expected ')' after type expression (System F)", () => {
      assert.throws(
        () => {
          const state = createParserState("(a->b");
          parseSystemFType(state);
        },
        {
          message: /expected '\)' after type expression/,
        },
      );
    });
  });

  describe("ski.ts errors", () => {
    it("unexpected token when expecting SKI term", () => {
      assert.throws(() => parseSKI("Z"), {
        message: /unexpected token.*when expecting an SKI term/,
      });
    });

    it("unexpected extra input (SKI)", () => {
      assert.throws(() => parseSKI("sX"), {
        message: /unexpected extra input/,
      });
    });
  });

  describe("Integration: multiple error scenarios", () => {
    it("module name with dots", () => {
      assert.throws(() => parseTripLang("module My.Module"), {
        message: /expected an identifier/,
      });
    });

    it("incomplete lambda abstraction", () => {
      assert.throws(() => parseSystemF("\\x:X"), {
        message: /expected '=>'/,
      });
    });

    it("incomplete type abstraction", () => {
      assert.throws(() => parseSystemF("#X"), {
        message: /expected '=>'/,
      });
    });

    it("unmatched parenthesis", () => {
      assert.throws(() => parseSystemF("(x"), {
        message: /expected '\)'/,
      });
    });

    it("extra right parenthesis", () => {
      assert.throws(() => parseSystemF("x)"), {
        message: /unexpected extra input/,
      });
    });

    it("missing equals in definition", () => {
      assert.throws(() => parseTripLang("module Test\npoly x y"), {
        message: /expected '='/,
      });
    });

    it("incomplete match expression", () => {
      assert.throws(() => parseSystemF("match x [T]"), {
        message: /expected '{'/,
      });
    });
  });
});
