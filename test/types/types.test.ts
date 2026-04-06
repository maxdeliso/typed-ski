import { test } from "node:test";
import { expect } from "../util/assertions.ts";

import { untypedApp, untypedAbs, mkVar } from "../../lib/terms/lambda.ts";
import { parseType } from "../../lib/parser/type.ts";
import { emptyContext } from "../../lib/types/typedLambda.ts";

import {
  arrow,
  arrows,
  type BaseType,
  mkTypeVariable,
  typesLitEq,
} from "../../lib/types/types.ts";
import { unparseType } from "../../lib/parser/type.ts";

import { inferType, substituteType, unify } from "../../lib/types/inference.ts";
import { normalize } from "../../lib/types/normalization.ts";

test("type utilities: construction, normalisation, inference, unification", async (t) => {
  await t.test("basic type operations", async (t) => {
    await t.test("literal equivalence & associativity", () => {
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

    await t.test("normalisation rules", async (t) => {
      await t.test("repeated variables", () => {
        const nonNorm = arrow(
          mkTypeVariable("q"),
          arrow(mkTypeVariable("p"), mkTypeVariable("q")),
        );
        const expected = arrow(
          mkTypeVariable("a"),
          arrow(mkTypeVariable("b"), mkTypeVariable("a")),
        );
        expect(unparseType(normalize(nonNorm))).to.equal(unparseType(expected));
      });

      await t.test("arrow chain fresh naming", () => {
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

      await t.test("already normal remains same", () => {
        const norm = arrow(
          mkTypeVariable("a"),
          arrow(mkTypeVariable("b"), mkTypeVariable("a")),
        );
        expect(typesLitEq(normalize(norm), norm)).to.equal(true);
      });
    });
  });

  await t.test("type inference", async (t) => {
    await t.test("successful cases", async (t) => {
      await t.test("I combinator", () => {
        const [, ty] = inferType(untypedAbs("x", mkVar("x")));
        const [, parsed] = parseType("a->a");
        expect(unparseType(ty)).to.equal(unparseType(parsed));
      });

      await t.test("K combinator", () => {
        const [, ty] = inferType(untypedAbs("x", untypedAbs("y", mkVar("x"))));
        const [, parsed] = parseType("a->b->a");
        expect(unparseType(ty)).to.equal(unparseType(parsed));
      });

      await t.test("S combinator", () => {
        const [, ty] = inferType(
          untypedAbs(
            "x",
            untypedAbs(
              "y",
              untypedAbs(
                "z",
                untypedApp(
                  untypedApp(mkVar("x"), mkVar("z")),
                  untypedApp(mkVar("y"), mkVar("z")),
                ),
              ),
            ),
          ),
        );
        const [, parsed] = parseType("(a->b->c)->(a->b)->a->c");

        expect(unparseType(ty)).to.equal(unparseType(parsed));
      });
    });

    await t.test("inference failures", async (t) => {
      await t.test("λx.xx fails (occurs check)", () => {
        expect(() =>
          inferType(untypedAbs("x", untypedApp(mkVar("x"), mkVar("x")))),
        ).to.throw(/occurs check failed/);
      });

      await t.test("λx.λy.(xy)x fails", () => {
        expect(() =>
          inferType(
            untypedAbs(
              "x",
              untypedAbs(
                "y",
                untypedApp(untypedApp(mkVar("x"), mkVar("y")), mkVar("x")),
              ),
            ),
          ),
        ).to.throw(/occurs check failed/);
      });
    });
  });

  await t.test("unification", async (t) => {
    await t.test("occurs-check errors", async (t) => {
      await t.test("variable occurs in own substitution", () => {
        const a = mkTypeVariable("a");
        const fun = arrow(a, mkTypeVariable("b"));
        expect(() => substituteType(a, a, fun)).to.throw(/occurs check failed/);
      });

      await t.test("unifying var with self-containing type", () => {
        const a = mkTypeVariable("a");
        const fun = arrow(a, mkTypeVariable("b"));
        let ctx = emptyContext();
        ctx = new Map(ctx);
        ctx.set("x", a);
        expect(() => unify(a, fun, ctx)).to.throw(/occurs check failed/);
      });
    });

    await t.test("arrow-type unification decomposes structure", () => {
      const a = mkTypeVariable("a");
      const b = mkTypeVariable("b");
      const c = mkTypeVariable("c");

      const t1 = arrow(a, a);
      const t2 = arrow(b, c);

      let ctx = emptyContext();
      ctx = new Map(ctx);
      ctx.set("x", t1);
      ctx = unify(t1, t2, ctx);

      const ty = ctx.get("x");
      expect(ty).to.satisfy((t: BaseType | undefined) => {
        if (!t || t.kind !== "non-terminal") return false;
        return typesLitEq(t.lft, t.rgt);
      });
    });
  });
});
