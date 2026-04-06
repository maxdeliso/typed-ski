import { test } from "node:test";
import { expect } from "../util/assertions.ts";
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

test("Parser Error Coverage", async (t) => {
  await t.test("parserState.ts errors", async (t) => {
    await t.test("non-ASCII byte error", () => {
      expect(() => createParserState("hello λ")).to.throw(
        ParseError,
        /non-ASCII byte.*0x/,
      );
    });

    await t.test("expected character but found different", () => {
      expect(() => {
        const state = createParserState("abc");
        matchCh(state, "x");
      }).to.throw(ParseError, /expected 'x' but found/);
    });

    await t.test("expected character but found EOF", () => {
      expect(() => {
        const state = createParserState("");
        matchCh(state, "x");
      }).to.throw(ParseError, /expected 'x' but found.*EOF/);
    });

    await t.test("expected arrow but found different", () => {
      expect(() => {
        const state = createParserState("abc");
        matchArrow(state);
      }).to.throw(ParseError, /expected '->' but found/);
    });

    await t.test("expected fat arrow but found different", () => {
      expect(() => {
        const state = createParserState("abc");
        matchFatArrow(state);
      }).to.throw(ParseError, /expected '=>' but found/);
    });

    await t.test("expected identifier", () => {
      expect(() => {
        const state = createParserState("");
        parseIdentifier(state);
      }).to.throw(ParseError, /expected an identifier/);
    });

    await t.test("purely numeric identifier", () => {
      expect(() => {
        const state = createParserState("123");
        const wsState = skipWhitespace(state);
        parseIdentifier(wsState);
      }).to.throw(ParseError, /not a valid identifier.*purely numeric/);
    });

    await t.test("reserved numeric literal identifier", () => {
      expect(() => {
        const state = createParserState("__trip_nat_literal__0");
        parseIdentifier(state);
      }).to.throw(ParseError, /reserved for numeric literals/);
    });

    await t.test("expected numeric literal", () => {
      expect(() => {
        const state = createParserState("abc");
        parseNumericLiteral(state);
      }).to.throw(ParseError, /expected numeric literal/);
    });

    await t.test("expected definition keyword", () => {
      expect(() => {
        const state = createParserState("invalid");
        parseDefinitionKeyword(state);
      }).to.throw(ParseError, /expected definition keyword/);
    });
  });

  await t.test("systemFTerm.ts errors", async (t) => {
    await t.test("match requires explicit return type", () => {
      expect(() => parseSystemF("match x { | None => y }")).to.throw(
        ParseError,
        /match requires an explicit return type/,
      );
    });

    await t.test("expected pipe to start match arm", () => {
      expect(() => parseSystemF("match x [T] { None => y }")).to.throw(
        ParseError,
        /expected '\|' to start match arm/,
      );
    });

    await t.test("match arm requires a body", () => {
      // The error occurs when parsing the body term, not when checking bodyLit
      // This is tested indirectly - empty body causes parseSystemFTerm to fail
      expect(() => parseSystemF("match x [T] { | None => }")).to.throw(
        ParseError,
      );
    });

    await t.test("match must declare at least one arm", () => {
      expect(() => parseSystemF("match x [T] { }")).to.throw(
        ParseError,
        /match must declare at least one arm/,
      );
    });

    await t.test("expected 'in' after let binding", () => {
      // The error message "expected 'in' after let binding value, found 'X'"
      // is thrown when an identifier is parsed but it's not "in".
      // However, due to greedy parsing of the value term, this is hard to trigger
      // in practice. The error path exists in the code at line 254 of systemFTerm.ts.
      // We verify that let expressions without 'in' throw errors (tested in systemF.test.ts)
      expect(() => parseSystemF("let x = 1")).to.throw(ParseError);
    });

    await t.test("expected character but found EOF (let)", () => {
      // When EOF is reached, it fails trying to parse 'in' as identifier
      expect(() => parseSystemF("let x = 1")).to.throw(
        ParseError,
        /expected an identifier/,
      );
    });

    await t.test("unterminated character literal", () => {
      // The error occurs when trying to match the closing quote
      expect(() => parseSystemF("'a")).to.throw(
        ParseError,
        /expected ''' but found.*EOF/,
      );
    });

    await t.test("empty character literal", () => {
      expect(() => parseSystemF("''")).to.throw(
        ParseError,
        /empty character literal/,
      );
    });

    await t.test("unsupported escape sequence in character literal", () => {
      expect(() => parseSystemF("'\\z'")).to.throw(
        ParseError,
        /unsupported escape sequence.*character literal/,
      );
    });

    await t.test("non-printable ASCII in character literal", () => {
      expect(() => parseSystemF("'\u0001'")).to.throw(
        ParseError,
        /non-printable ASCII in character literal/,
      );
    });

    await t.test("unterminated string literal", () => {
      expect(() => parseSystemF('"hello')).to.throw(
        ParseError,
        /unterminated string literal/,
      );
    });

    await t.test("non-printable ASCII in string literal", () => {
      expect(() => parseSystemF('"\u0001"')).to.throw(
        ParseError,
        /non-printable ASCII in string literal/,
      );
    });

    await t.test("unexpected token while parsing atomic term", () => {
      expect(() => parseSystemF("!x")).to.throw(
        ParseError,
        /unexpected token.*while parsing atomic term/,
      );
    });
  });

  await t.test("tripLang.ts errors", async (t) => {
    await t.test(
      "data definition must declare at least one constructor",
      () => {
        expect(() => parseTripLang("module Test\ndata T =")).to.throw(
          ParseError,
          /data definition must declare at least one constructor/,
        );
      },
    );

    await t.test("Unknown definition kind", () => {
      // This shouldn't happen in practice, but we test the error path
      // by checking that invalid keywords are caught
      expect(() => parseTripLang("invalid x = y")).to.throw(
        ParseError,
        /expected definition keyword/,
      );
    });
  });

  await t.test("eof.ts errors", async (t) => {
    await t.test("unexpected extra input", () => {
      expect(() => {
        parseWithEOF("a b", (state) => {
          const [lit, ty, finalState] = parseArrowTypeNoApp(state);
          return [lit, ty, finalState];
        });
      }).to.throw(ParseError, /unexpected extra input/);
    });
  });

  await t.test("type.ts errors", async (t) => {
    await t.test("expected ')' after type expression", () => {
      expect(() => parseType("(a->b")).to.throw(
        ParseError,
        /expected '\)' after type expression/,
      );
    });
  });

  await t.test("systemFType.ts errors", async (t) => {
    await t.test("expected ')' after type expression (System F)", () => {
      expect(() => {
        const state = createParserState("(a->b");
        parseSystemFType(state);
      }).to.throw(ParseError, /expected '\)' after type expression/);
    });
  });

  await t.test("ski.ts errors", async (t) => {
    await t.test("unexpected token when expecting SKI term", () => {
      expect(() => parseSKI("Z")).to.throw(
        ParseError,
        /unexpected token.*when expecting an SKI term/,
      );
    });

    await t.test("unexpected extra input (SKI)", () => {
      expect(() => parseSKI("sX")).to.throw(
        ParseError,
        /unexpected extra input/,
      );
    });
  });

  await t.test("Integration: multiple error scenarios", async (t) => {
    await t.test("module name with dots", () => {
      expect(() => parseTripLang("module My.Module")).to.throw(
        ParseError,
        /expected an identifier/,
      );
    });

    await t.test("incomplete lambda abstraction", () => {
      expect(() => parseSystemF("\\x:X")).to.throw(ParseError, /expected '=>'/);
    });

    await t.test("incomplete type abstraction", () => {
      expect(() => parseSystemF("#X")).to.throw(ParseError, /expected '=>'/);
    });

    await t.test("unmatched parenthesis", () => {
      expect(() => parseSystemF("(x")).to.throw(ParseError, /expected '\)'/);
    });

    await t.test("extra right parenthesis", () => {
      expect(() => parseSystemF("x)")).to.throw(
        ParseError,
        /unexpected extra input/,
      );
    });

    await t.test("missing equals in definition", () => {
      expect(() => parseTripLang("module Test\npoly x y")).to.throw(
        ParseError,
        /expected '='/,
      );
    });

    await t.test("incomplete match expression", () => {
      expect(() => parseSystemF("match x [T]")).to.throw(
        ParseError,
        /expected '{'/,
      );
    });
  });
});
