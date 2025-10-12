import { expect } from "chai";
import { mkVar } from "../../lib/terms/lambda.ts";
import { createTypedApplication } from "../../lib/types/typedLambda.ts";

import { ParseError } from "../../lib/parser/parseError.ts";
import { parseType } from "../../lib/parser/type.ts";
import { parseTypedLambda } from "../../lib/parser/typedLambda.ts";

import { mkTypedAbs, typedTermsLitEq } from "../../lib/types/typedLambda.ts";
import {
  arrow,
  arrows,
  mkTypeVariable,
  typesLitEq,
} from "../../lib/types/types.ts";

Deno.test("Parser Tests", async (t) => {
  await t.step("parseType", async (t) => {
    await t.step("parses a simple variable type", () => {
      const src = "a";
      const [lit, ty] = parseType(src);
      expect(lit).to.equal(src);
      expect(typesLitEq(ty, mkTypeVariable("a"))).to.equal(true);
    });

    await t.step("parses the type a→b", () => {
      const src = "a→b";
      const [lit, ty] = parseType(src);
      expect(lit).to.equal(src);
      expect(typesLitEq(ty, arrow(mkTypeVariable("a"), mkTypeVariable("b"))))
        .to.equal(true);
    });

    await t.step("parses the type a→b→c", () => {
      const src = "a→b→c";
      const [lit, ty] = parseType(src);
      const expected = arrow(
        mkTypeVariable("a"),
        arrow(mkTypeVariable("b"), mkTypeVariable("c")),
      );
      expect(lit).to.equal(src);
      expect(typesLitEq(ty, expected)).to.equal(true);
    });

    await t.step("parses (a→b)→a→b", () => {
      const src = "(a→b)→a→b";
      const [lit, ty] = parseType(src);
      const expected = arrow(
        arrow(mkTypeVariable("a"), mkTypeVariable("b")),
        arrow(mkTypeVariable("a"), mkTypeVariable("b")),
      );
      expect(lit).to.equal(src);
      expect(typesLitEq(ty, expected)).to.equal(true);
    });

    await t.step("parses a→b→a→b", () => {
      const src = "a→b→a→b";
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

    await t.step("parses nested-parentheses arrow type", () => {
      const src = "((a→b)→c)→d";
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

    await t.step("skips excess whitespace in types", () => {
      const src = "   a   →    b   ";
      const [lit, ty] = parseType(src);
      const expected = arrow(mkTypeVariable("a"), mkTypeVariable("b"));
      expect(lit).to.equal("a→b");
      expect(typesLitEq(ty, expected)).to.equal(true);
    });
  });

  await t.step("parseTypedLambda", async (t) => {
    await t.step("successful parsing", async (t) => {
      await t.step("single term application", () => {
        const src = "x y";
        const [lit, term] = parseTypedLambda(src);
        const expected = createTypedApplication(mkVar("x"), mkVar("y"));
        expect(lit).to.equal(src);
        expect(typedTermsLitEq(term, expected)).to.equal(true);
      });

      await t.step("juxtaposed terms", () => {
        const src = "x z (y z)";
        const [lit, term] = parseTypedLambda(src);
        const expected = createTypedApplication(
          createTypedApplication(mkVar("x"), mkVar("z")),
          createTypedApplication(mkVar("y"), mkVar("z")),
        );
        expect(lit).to.equal(src);
        expect(typedTermsLitEq(term, expected)).to.equal(true);
      });

      await t.step("λx:a.xx", () => {
        const src = "λx:a.x x";
        const [lit, term] = parseTypedLambda(src);
        const expected = mkTypedAbs(
          "x",
          mkTypeVariable("a"),
          createTypedApplication(mkVar("x"), mkVar("x")),
        );
        expect(lit).to.equal(src);
        expect(typedTermsLitEq(term, expected)).to.equal(true);
      });

      await t.step("combinator K", () => {
        const src = "λx:a.λy:b.x";
        const [lit, term] = parseTypedLambda(src);
        const expected = mkTypedAbs(
          "x",
          mkTypeVariable("a"),
          mkTypedAbs("y", mkTypeVariable("b"), mkVar("x")),
        );
        expect(lit).to.equal(src);
        expect(typedTermsLitEq(term, expected)).to.equal(true);
      });

      await t.step("combinator S", () => {
        const src = "λx:a→b→c.λy:a→b.λz:a.x z (y z)";
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

      await t.step("parenthesised whole abstraction", () => {
        const src = "(λx:a.x)";
        const [lit, term] = parseTypedLambda(src);
        const expected = mkTypedAbs("x", mkTypeVariable("a"), mkVar("x"));
        expect(lit).to.equal(src);
        expect(typedTermsLitEq(term, expected)).to.equal(true);
      });

      await t.step("nested parentheses in type annotation", () => {
        const src = "λx:(a→b)→c.x";
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

      await t.step("skips extra whitespace", () => {
        const src = "  λ   x  :  a   .   x   ";
        const [lit, term] = parseTypedLambda(src);
        const expected = mkTypedAbs("x", mkTypeVariable("a"), mkVar("x"));
        expect(lit).to.equal("λx:a.x");
        expect(typedTermsLitEq(term, expected)).to.equal(true);
      });
    });

    await t.step("error cases", async (t) => {
      const shouldThrow = (
        src: string,
        msg?: RegExp,
      ) =>
      () => {
        expect(() => parseTypedLambda(src)).to.throw(ParseError, msg);
      };

      await t.step("missing variable", shouldThrow("λ:a→b.x", /identifier/));

      await t.step(
        "incomplete type",
        shouldThrow("λx:a→.x", /identifier/),
      );

      await t.step("missing term", shouldThrow("λx:a→b.", /term/));

      await t.step(
        "unmatched left parenthesis",
        shouldThrow("(λx:a.x"),
      );

      await t.step(
        "extra right parenthesis",
        shouldThrow("λx:a.x))"),
      );

      await t.step(
        "incomplete lambda abstraction",
        shouldThrow("λx:a→b.", /term/),
      );

      await t.step(
        "incomplete type annotation",
        shouldThrow("λx:a→.x"),
      );
    });
  });
});
