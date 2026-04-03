import { test } from "node:test";
import { expect } from "../util/assertions.ts";
import { mkVar } from "../../lib/terms/lambda.ts";
import {
  createTypedApplication,
  mkTypedAbs,
  typedTermsLitEq,
} from "../util/ast.ts";
import { ParseError } from "../../lib/parser/parseError.ts";
import { parseArrowTypeNoApp, parseType } from "../../lib/parser/type.ts";
import { parseTypedLambda } from "../../lib/parser/typedLambda.ts";
import { createParserState } from "../../lib/parser/parserState.ts";
import { makeTypedBinNumeral } from "../../lib/types/binLiteral.ts";
import {
  arrow,
  arrows,
  mkTypeVariable,
  typeApp,
  typesLitEq,
} from "../../lib/types/types.ts";

test("Parser Tests", async (t) => {
  await t.test("parseType", async (t) => {
    await t.test("parses a simple variable type", () => {
      const src = "a";
      const [lit, ty] = parseType(src);
      expect(lit).to.equal(src);
      expect(typesLitEq(ty, mkTypeVariable("a"))).to.equal(true);
    });

    await t.test("parses the type a->b", () => {
      const src = "a->b";
      const [lit, ty] = parseType(src);
      expect(lit).to.equal(src);
      expect(
        typesLitEq(ty, arrow(mkTypeVariable("a"), mkTypeVariable("b"))),
      ).to.equal(true);
    });

    await t.test("parses the type a->b->c", () => {
      const src = "a->b->c";
      const [lit, ty] = parseType(src);
      const expected = arrow(
        mkTypeVariable("a"),
        arrow(mkTypeVariable("b"), mkTypeVariable("c")),
      );
      expect(lit).to.equal(src);
      expect(typesLitEq(ty, expected)).to.equal(true);
    });

    await t.test("parses (a->b)->a->b", () => {
      const src = "(a->b)->a->b";
      const [lit, ty] = parseType(src);
      const expected = arrow(
        arrow(mkTypeVariable("a"), mkTypeVariable("b")),
        arrow(mkTypeVariable("a"), mkTypeVariable("b")),
      );
      expect(lit).to.equal(src);
      expect(typesLitEq(ty, expected)).to.equal(true);
    });

    await t.test("parses a->b->a->b", () => {
      const src = "a->b->a->b";
      const [lit, ty] = parseType(src);
      const expected = arrows(
        mkTypeVariable("a"),
        mkTypeVariable("b"),
        mkTypeVariable("a"),
        mkTypeVariable("b"),
      );
      expect(lit).to.equal(src);
      expect(typesLitEq(ty, expected)).to.equal(true);
    });

    await t.test("parses nested-parentheses arrow type", () => {
      const src = "((a->b)->c)->d";
      const [lit, ty] = parseType(src);
      const expected = arrow(
        arrow(
          arrow(mkTypeVariable("a"), mkTypeVariable("b")),
          mkTypeVariable("c"),
        ),
        mkTypeVariable("d"),
      );
      expect(lit).to.equal(src);
      expect(typesLitEq(ty, expected)).to.equal(true);
    });

    await t.test("skips excess whitespace in types", () => {
      const src = "   a   ->    b   ";
      const [lit, ty] = parseType(src);
      const expected = arrow(mkTypeVariable("a"), mkTypeVariable("b"));
      expect(lit).to.equal("a->b");
      expect(typesLitEq(ty, expected)).to.equal(true);
    });

    await t.test("parses type applications", () => {
      const src = "List Nat";
      const [lit, ty] = parseType(src);
      const expected = typeApp(mkTypeVariable("List"), mkTypeVariable("Nat"));
      expect(lit).to.equal("List Nat");
      expect(typesLitEq(ty, expected)).to.equal(true);
    });

    await t.test("parses nested type applications", () => {
      const src = "Result ParseError (Pair A (List Nat))";
      const [lit, ty] = parseType(src);
      const listNat = typeApp(mkTypeVariable("List"), mkTypeVariable("Nat"));
      const pair = typeApp(
        typeApp(mkTypeVariable("Pair"), mkTypeVariable("A")),
        listNat,
      );
      const expected = typeApp(
        typeApp(mkTypeVariable("Result"), mkTypeVariable("ParseError")),
        pair,
      );
      expect(lit).to.equal(src);
      expect(typesLitEq(ty, expected)).to.equal(true);
    });

    await t.test("application binds tighter than arrows", () => {
      const src = "List Nat -> Bool";
      const [lit, ty] = parseType(src);
      const expected = arrow(
        typeApp(mkTypeVariable("List"), mkTypeVariable("Nat")),
        mkTypeVariable("Bool"),
      );
      expect(lit).to.equal("List Nat->Bool");
      expect(typesLitEq(ty, expected)).to.equal(true);
    });
  });

  await t.test("parseArrowTypeNoApp", async (t) => {
    await t.test("parses a simple type variable", () => {
      const src = "a";
      const state = createParserState(src);
      const [lit, ty, finalState] = parseArrowTypeNoApp(state);
      expect(lit).to.equal(src);
      expect(typesLitEq(ty, mkTypeVariable("a"))).to.equal(true);
      expect(finalState.idx).to.equal(src.length);
    });

    await t.test("parses simple arrow type", () => {
      const src = "a->b";
      const state = createParserState(src);
      const [lit, ty, finalState] = parseArrowTypeNoApp(state);
      expect(lit).to.equal(src);
      expect(
        typesLitEq(ty, arrow(mkTypeVariable("a"), mkTypeVariable("b"))),
      ).to.equal(true);
      expect(finalState.idx).to.equal(src.length);
    });

    await t.test("parses multiple arrows", () => {
      const src = "a->b->c";
      const state = createParserState(src);
      const [lit, ty, finalState] = parseArrowTypeNoApp(state);
      const expected = arrow(
        mkTypeVariable("a"),
        arrow(mkTypeVariable("b"), mkTypeVariable("c")),
      );
      expect(lit).to.equal(src);
      expect(typesLitEq(ty, expected)).to.equal(true);
      expect(finalState.idx).to.equal(src.length);
    });

    await t.test("parses parenthesized types", () => {
      const src = "(a->b)->c";
      const state = createParserState(src);
      const [lit, ty, finalState] = parseArrowTypeNoApp(state);
      const expected = arrow(
        arrow(mkTypeVariable("a"), mkTypeVariable("b")),
        mkTypeVariable("c"),
      );
      expect(lit).to.equal(src);
      expect(typesLitEq(ty, expected)).to.equal(true);
      expect(finalState.idx).to.equal(src.length);
    });

    await t.test("does not parse type applications", () => {
      const src = "List Nat";
      const state = createParserState(src);
      const [lit, ty, finalState] = parseArrowTypeNoApp(state);
      // Should only parse "List", not "List Nat" as a type application
      expect(lit).to.equal("List");
      expect(typesLitEq(ty, mkTypeVariable("List"))).to.equal(true);
      // Should leave "Nat" in the remaining state
      expect(finalState.idx).to.be.lessThan(src.length);
      const remaining = src.slice(finalState.idx).trim();
      expect(remaining).to.equal("Nat");
    });

    await t.test("skips whitespace", () => {
      const src = "   a   ->    b   ";
      const state = createParserState(src);
      const [lit, ty, _finalState] = parseArrowTypeNoApp(state);
      expect(lit).to.equal("a->b");
      expect(
        typesLitEq(ty, arrow(mkTypeVariable("a"), mkTypeVariable("b"))),
      ).to.equal(true);
    });

    await t.test("handles nested parentheses", () => {
      const src = "((a->b)->c)->d";
      const state = createParserState(src);
      const [lit, ty, finalState] = parseArrowTypeNoApp(state);
      const expected = arrow(
        arrow(
          arrow(mkTypeVariable("a"), mkTypeVariable("b")),
          mkTypeVariable("c"),
        ),
        mkTypeVariable("d"),
      );
      expect(lit).to.equal(src);
      expect(typesLitEq(ty, expected)).to.equal(true);
      expect(finalState.idx).to.equal(src.length);
    });
  });

  await t.test("parseTypedLambda", async (t) => {
    await t.test("successful parsing", async (t) => {
      await t.test("single term application", () => {
        const src = "x y";
        const [lit, term] = parseTypedLambda(src);
        const expected = createTypedApplication(mkVar("x"), mkVar("y"));
        expect(lit).to.equal(src);
        expect(typedTermsLitEq(term, expected)).to.equal(true);
      });

      await t.test("juxtaposed terms", () => {
        const src = "x z (y z)";
        const [lit, term] = parseTypedLambda(src);
        const expected = createTypedApplication(
          createTypedApplication(mkVar("x"), mkVar("z")),
          createTypedApplication(mkVar("y"), mkVar("z")),
        );
        expect(lit).to.equal(src);
        expect(typedTermsLitEq(term, expected)).to.equal(true);
      });

      await t.test("\\x:a=>x x", () => {
        const src = "\\x:a=>x x";
        const [lit, term] = parseTypedLambda(src);
        const expected = mkTypedAbs(
          "x",
          mkTypeVariable("a"),
          createTypedApplication(mkVar("x"), mkVar("x")),
        );
        expect(lit).to.equal(src);
        expect(typedTermsLitEq(term, expected)).to.equal(true);
      });

      await t.test("combinator K", () => {
        const src = "\\x:a=>\\y:b=>x";
        const [lit, term] = parseTypedLambda(src);
        const expected = mkTypedAbs(
          "x",
          mkTypeVariable("a"),
          mkTypedAbs("y", mkTypeVariable("b"), mkVar("x")),
        );
        expect(lit).to.equal(src);
        expect(typedTermsLitEq(term, expected)).to.equal(true);
      });

      await t.test("combinator S", () => {
        const src = "\\x:a->b->c=>\\y:a->b=>\\z:a=>x z (y z)";
        const [lit, term] = parseTypedLambda(src);
        const expected = mkTypedAbs(
          "x",
          arrows(mkTypeVariable("a"), mkTypeVariable("b"), mkTypeVariable("c")),
          mkTypedAbs(
            "y",
            arrow(mkTypeVariable("a"), mkTypeVariable("b")),
            mkTypedAbs(
              "z",
              mkTypeVariable("a"),
              createTypedApplication(
                createTypedApplication(mkVar("x"), mkVar("z")),
                createTypedApplication(mkVar("y"), mkVar("z")),
              ),
            ),
          ),
        );
        expect(lit).to.equal(src);
        expect(typedTermsLitEq(term, expected)).to.equal(true);
      });

      await t.test("parenthesised whole abstraction", () => {
        const src = "(\\x:a=>x)";
        const [lit, term] = parseTypedLambda(src);
        const expected = mkTypedAbs("x", mkTypeVariable("a"), mkVar("x"));
        expect(lit).to.equal(src);
        expect(typedTermsLitEq(term, expected)).to.equal(true);
      });

      await t.test("nested parentheses in type annotation", () => {
        const src = "\\x:(a->b)->c=>x";
        const [lit, term] = parseTypedLambda(src);
        const expected = mkTypedAbs(
          "x",
          arrow(
            arrow(mkTypeVariable("a"), mkTypeVariable("b")),
            mkTypeVariable("c"),
          ),
          mkVar("x"),
        );
        expect(lit).to.equal(src);
        expect(typedTermsLitEq(term, expected)).to.equal(true);
      });

      await t.test("skips extra whitespace", () => {
        const src = "  \\   x  :  a   =>   x   ";
        const [lit, term] = parseTypedLambda(src);
        const expected = mkTypedAbs("x", mkTypeVariable("a"), mkVar("x"));
        expect(lit).to.equal("\\x:a=>x");
        expect(typedTermsLitEq(term, expected)).to.equal(true);
      });

      await t.test("parses nat literal", () => {
        const src = "42";
        const [lit, term] = parseTypedLambda(src);
        expect(lit).to.equal("42");
        expect(typedTermsLitEq(term, makeTypedBinNumeral(42n))).to.equal(true);
      });
    });

    await t.test("error cases", async (t) => {
      const shouldThrow = (src: string, msg?: RegExp) => () => {
        expect(() => parseTypedLambda(src)).to.throw(ParseError, msg);
      };

      await t.test("missing variable", shouldThrow("\\:a->b=>x", /identifier/));

      await t.test("incomplete type", shouldThrow("\\x:a->=>x", /identifier/));

      await t.test("missing term", shouldThrow("\\x:a->b=>", /term/));

      await t.test("unmatched left parenthesis", shouldThrow("(\\x:a=>x"));

      await t.test("extra right parenthesis", shouldThrow("\\x:a=>x))"));

      await t.test(
        "incomplete lambda abstraction",
        shouldThrow("\\x:a->b=>", /term/),
      );

      await t.test("incomplete type annotation", shouldThrow("\\x:a->=>x"));

      await t.test(
        "rejects purely numeric identifiers in lambda bindings",
        shouldThrow("\\123:a=>x", /not a valid identifier.*purely numeric/),
      );

      await t.test(
        "rejects non-ASCII bytes",
        shouldThrow("λx:a.x", /non-ASCII byte/),
      );
    });
  });
});
