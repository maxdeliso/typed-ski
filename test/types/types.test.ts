import { expect } from "npm:chai";

import { cons } from "../../lib/cons.ts";
import {
  mkUntypedAbs,
  mkVar,
  type UntypedLambda,
} from "../../lib/terms/lambda.ts";
import { parseType } from "../../lib/parser/type.ts";
import { parseTypedLambda } from "../../lib/parser/typedLambda.ts";

import { emptyContext, typedTermsLitEq } from "../../lib/types/typedLambda.ts";

import {
  arrow,
  arrows,
  type BaseType,
  mkTypeVariable,
  prettyPrintTy,
  typesLitEq,
} from "../../lib/types/types.ts";

import { inferType, substituteType, unify } from "../../lib/types/inference.ts";
import { normalize } from "../../lib/types/normalization.ts";

import { insertAVL, searchAVL } from "../../lib/data/avl/avlNode.ts";
import { compareStrings } from "../../lib/data/map/stringMap.ts";

Deno.test("type utilities: construction, normalisation, inference, unification", async (t) => {
  await t.step("basic type operations", async (t) => {
    await t.step("literal equivalence & associativity", () => {
      const t1 = arrows(
        mkTypeVariable("a"),
        mkTypeVariable("b"),
        mkTypeVariable("c"),
      );
      const t2 = arrows(
        mkTypeVariable("a"),
        mkTypeVariable("b"),
        mkTypeVariable("d"),
      );
      const t3 = arrows(
        mkTypeVariable("d"),
        mkTypeVariable("e"),
        mkTypeVariable("f"),
      );

      expect(typesLitEq(t1, t1)).to.equal(true);
      expect(typesLitEq(t1, t2)).to.equal(false);
      expect(typesLitEq(t1, t3)).to.equal(false);

      // right-associative construction
      expect(
        typesLitEq(
          arrows(mkTypeVariable("a"), mkTypeVariable("b"), mkTypeVariable("c")),
          arrow(
            mkTypeVariable("a"),
            arrow(mkTypeVariable("b"), mkTypeVariable("c")),
          ),
        ),
      ).to.equal(true);
    });

    await t.step("normalisation rules", async (t) => {
      await t.step("repeated variables", () => {
        const nonNorm = arrow(
          mkTypeVariable("q"),
          arrow(mkTypeVariable("p"), mkTypeVariable("q")),
        );
        const expected = arrow(
          mkTypeVariable("a"),
          arrow(mkTypeVariable("b"), mkTypeVariable("a")),
        );
        expect(prettyPrintTy(normalize(nonNorm))).to.equal(
          prettyPrintTy(expected),
        );
      });

      await t.step("arrow chain fresh naming", () => {
        const nonNorm = arrows(
          mkTypeVariable("x"),
          mkTypeVariable("y"),
          mkTypeVariable("z"),
        );
        const expected = arrows(
          mkTypeVariable("a"),
          mkTypeVariable("b"),
          mkTypeVariable("c"),
        );
        expect(typesLitEq(normalize(nonNorm), expected)).to.equal(true);
      });

      await t.step("already normal remains same", () => {
        const norm = arrow(
          mkTypeVariable("a"),
          arrow(mkTypeVariable("b"), mkTypeVariable("a")),
        );
        expect(typesLitEq(normalize(norm), norm)).to.equal(true);
      });
    });
  });

  await t.step("type inference", async (t) => {
    await t.step("successful cases", async (t) => {
      await t.step("I combinator", () => {
        const [term, ty] = inferType(mkUntypedAbs("x", mkVar("x")));
        const [, typed] = parseTypedLambda("λx:a.x");
        const [, parsed] = parseType("a→a");

        expect(typedTermsLitEq(term, typed)).to.equal(true);
        expect(prettyPrintTy(ty)).to.equal(prettyPrintTy(parsed));
      });

      await t.step("K combinator", () => {
        const [term, ty] = inferType(
          mkUntypedAbs("x", mkUntypedAbs("y", mkVar("x"))),
        );
        const [, typed] = parseTypedLambda("λx:a.λy:b.x");
        const [, parsed] = parseType("a→b→a");

        expect(typedTermsLitEq(term, typed)).to.equal(true);
        expect(prettyPrintTy(ty)).to.equal(prettyPrintTy(parsed));
      });

      await t.step("S combinator", () => {
        const [term, ty] = inferType(
          mkUntypedAbs(
            "x",
            mkUntypedAbs(
              "y",
              mkUntypedAbs(
                "z",
                cons(
                  cons(mkVar("x"), mkVar("z")),
                  cons(mkVar("y"), mkVar("z")),
                ),
              ),
            ),
          ),
        );
        const [, typed] = parseTypedLambda("λx:a→b→c.λy:a→b.λz:a.x z(y z)");
        const [, parsed] = parseType("(a→b→c)→(a→b)→a→c");

        expect(prettyPrintTy(ty)).to.equal(prettyPrintTy(parsed));
        expect(typedTermsLitEq(term, typed)).to.equal(true);
      });

      await t.step("λx.λy.xy", () => {
        const [term, ty] = inferType(
          mkUntypedAbs("x", mkUntypedAbs("y", cons(mkVar("x"), mkVar("y")))),
        );
        const [, typed] = parseTypedLambda("λx:a→b.λy:a.x y");
        const [, parsed] = parseType("(a→b)→(a→b)");

        expect(prettyPrintTy(ty)).to.equal(prettyPrintTy(parsed));
        expect(typedTermsLitEq(term, typed)).to.equal(true);
      });
    });

    await t.step("inference failures", async (t) => {
      await t.step("λx.xx fails (occurs check)", () => {
        expect(() => inferType(mkUntypedAbs("x", cons(mkVar("x"), mkVar("x")))))
          .to.throw(/occurs check failed/);
      });

      await t.step("λx.λy.(xy)x fails", () => {
        expect(() =>
          inferType(
            mkUntypedAbs(
              "x",
              mkUntypedAbs(
                "y",
                cons<UntypedLambda>(
                  cons<UntypedLambda>(mkVar("x"), mkVar("y")),
                  mkVar("x"),
                ),
              ),
            ),
          )
        )
          .to.throw(/occurs check failed/);
      });
    });
  });

  await t.step("unification", async (t) => {
    await t.step("occurs-check errors", async (t) => {
      await t.step("variable occurs in own substitution", () => {
        const a = mkTypeVariable("a");
        const fun = arrow(a, mkTypeVariable("b"));
        expect(() => substituteType(a, a, fun)).to.throw(/occurs check failed/);
      });

      await t.step("unifying var with self-containing type", () => {
        const a = mkTypeVariable("a");
        const fun = arrow(a, mkTypeVariable("b"));
        let ctx = emptyContext();
        ctx = insertAVL(ctx, "x", a, compareStrings);
        expect(() => unify(a, fun, ctx)).to.throw(/occurs check failed/);
      });
    });

    await t.step("arrow-type unification decomposes structure", () => {
      const a = mkTypeVariable("a");
      const b = mkTypeVariable("b");
      const c = mkTypeVariable("c");

      const t1 = arrow(a, a);
      const t2 = arrow(b, c);

      let ctx = emptyContext();
      ctx = insertAVL(ctx, "x", t1, compareStrings);
      ctx = unify(t1, t2, ctx);

      expect(searchAVL(ctx, "x", compareStrings)).to.satisfy((ty: BaseType) => {
        if (ty.kind !== "non-terminal") return false;
        return typesLitEq(ty.lft, ty.rgt);
      });
    });
  });
});
