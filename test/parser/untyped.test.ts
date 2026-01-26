import { expect } from "chai";

import {
  mkUntypedAbs,
  mkVar,
  prettyPrintUntypedLambda,
  typelessApp,
} from "../../lib/terms/lambda.ts";
import { makeUntypedChurchNumeral } from "../../lib/consts/nat.ts";

import { parseLambda } from "../../lib/parser/untyped.ts";
import { predLambda } from "../../lib/consts/lambdas.ts";

Deno.test("Parser - untyped λ-calculus", async (t) => {
  await t.step("parseLambda → application parsing", async (t) => {
    await t.step("simple application", () => {
      const src = "a b";
      const [lit, term] = parseLambda(src);
      expect(lit).to.equal(src);
      expect(term).to.deep.equal(typelessApp(mkVar("a"), mkVar("b")));
    });

    await t.step("application with parentheses", () => {
      const src = "(a b)";
      const [lit, term] = parseLambda(src);
      expect(lit).to.equal(src);
      expect(term).to.deep.equal(typelessApp(mkVar("a"), mkVar("b")));
    });

    await t.step("nested application", () => {
      const src = "a (b c)";
      const [lit, term] = parseLambda(src);
      expect(lit).to.equal(src);
      expect(term).to.deep.equal(
        typelessApp(mkVar("a"), typelessApp(mkVar("b"), mkVar("c"))),
      );
    });

    await t.step("parses nat literal", () => {
      const src = "7";
      const [lit, term] = parseLambda(src);
      expect(lit).to.equal(src);
      expect(term).to.deep.equal(makeUntypedChurchNumeral(7n));
    });
  });

  await t.step("parseLambda → error cases", async (t) => {
    await t.step(
      "rejects purely numeric identifiers in lambda bindings",
      () => {
        // Purely numeric strings should be parsed as numeric literals, not identifiers
        // This test verifies that lambda abstractions with numeric bindings are rejected
        expect(() => parseLambda("\\123=>x")).to.throw(
          Error,
          /not a valid identifier.*purely numeric/,
        );
      },
    );
  });

  await t.step("parseLambda → complex expressions", async (t) => {
    await t.step("var applied to λ-expression", () => {
      const src = "a (\\b=>b (a a))";
      const [lit, term] = parseLambda(src);
      expect(lit).to.equal(src);
      expect(term).to.deep.equal(
        typelessApp(
          mkVar("a"),
          mkUntypedAbs(
            "b",
            typelessApp(mkVar("b"), typelessApp(mkVar("a"), mkVar("a"))),
          ),
        ),
      );
    });

    await t.step("parses Church-style predecessor (pred)", () => {
      const src =
        "\\n=> \\f=> \\x=> n (\\g=> \\h=> h (g f)) (\\u=> x) (\\u=> u)";

      // Expected AST
      const expected = mkUntypedAbs(
        "n",
        mkUntypedAbs(
          "f",
          mkUntypedAbs(
            "x",
            typelessApp(
              typelessApp(
                typelessApp(
                  mkVar("n"),
                  mkUntypedAbs(
                    "g",
                    mkUntypedAbs(
                      "h",
                      typelessApp(
                        mkVar("h"),
                        typelessApp(mkVar("g"), mkVar("f")),
                      ),
                    ),
                  ),
                ),
                mkUntypedAbs("u", mkVar("x")),
              ),
              mkUntypedAbs("u", mkVar("u")),
            ),
          ),
        ),
      );

      // parse → pretty-print → parse again round-trip
      const [, term] = parseLambda(src);
      expect(term).to.deep.equal(expected);

      const pretty = prettyPrintUntypedLambda(term);
      const [, reparsed] = parseLambda(pretty);
      expect(reparsed).to.deep.equal(expected);

      // extra sanity check against pre-defined constant
      expect(reparsed).to.deep.equal(predLambda);
    });
  });
});
