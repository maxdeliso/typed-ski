import { describe, it } from "../util/test_shim.ts";
import assert from "node:assert/strict";

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

describe("type utilities: construction, normalisation, inference, unification", () => {
  describe("basic type operations", () => {
    it("literal equivalence & associativity", () => {
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

      assert.ok(typesLitEq(t1, t1));
      assert.ok(!typesLitEq(t1, t2));
      assert.ok(!typesLitEq(t1, t3));

      // right-associative construction
      assert.ok(
        typesLitEq(
          arrows(mkTypeVariable("a"), mkTypeVariable("b"), mkTypeVariable("c")),
          arrow(
            mkTypeVariable("a"),
            arrow(mkTypeVariable("b"), mkTypeVariable("c")),
          ),
        ),
      );
    });

    describe("normalisation rules", () => {
      it("repeated variables", () => {
        const nonNorm = arrow(
          mkTypeVariable("q"),
          arrow(mkTypeVariable("p"), mkTypeVariable("q")),
        );
        const expected = arrow(
          mkTypeVariable("a"),
          arrow(mkTypeVariable("b"), mkTypeVariable("a")),
        );
        assert.strictEqual(
          unparseType(normalize(nonNorm)),
          unparseType(expected),
        );
      });

      it("arrow chain fresh naming", () => {
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
        assert.ok(typesLitEq(normalize(nonNorm), expected));
      });

      it("already normal remains same", () => {
        const norm = arrow(
          mkTypeVariable("a"),
          arrow(mkTypeVariable("b"), mkTypeVariable("a")),
        );
        assert.ok(typesLitEq(normalize(norm), norm));
      });
    });
  });

  describe("type inference", () => {
    describe("successful cases", () => {
      it("I combinator", () => {
        const [, ty] = inferType(untypedAbs("x", mkVar("x")));
        const [, parsed] = parseType("a->a");
        assert.strictEqual(unparseType(ty), unparseType(parsed));
      });

      it("K combinator", () => {
        const [, ty] = inferType(untypedAbs("x", untypedAbs("y", mkVar("x"))));
        const [, parsed] = parseType("a->b->a");
        assert.strictEqual(unparseType(ty), unparseType(parsed));
      });

      it("S combinator", () => {
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

        assert.strictEqual(unparseType(ty), unparseType(parsed));
      });
    });

    describe("inference failures", () => {
      it("λx.xx fails (occurs check)", () => {
        assert.throws(
          () => inferType(untypedAbs("x", untypedApp(mkVar("x"), mkVar("x")))),
          /occurs check failed/,
        );
      });

      it("λx.λy.(xy)x fails", () => {
        assert.throws(
          () =>
            inferType(
              untypedAbs(
                "x",
                untypedAbs(
                  "y",
                  untypedApp(untypedApp(mkVar("x"), mkVar("y")), mkVar("x")),
                ),
              ),
            ),
          /occurs check failed/,
        );
      });
    });
  });

  describe("unification", () => {
    describe("occurs-check errors", () => {
      it("variable occurs in own substitution", () => {
        const a = mkTypeVariable("a");
        const fun = arrow(a, mkTypeVariable("b"));
        assert.throws(() => substituteType(a, a, fun), /occurs check failed/);
      });

      it("unifying var with self-containing type", () => {
        const a = mkTypeVariable("a");
        const fun = arrow(a, mkTypeVariable("b"));
        let ctx = emptyContext();
        ctx = new Map(ctx);
        ctx.set("x", a);
        assert.throws(() => unify(a, fun, ctx), /occurs check failed/);
      });
    });

    it("arrow-type unification decomposes structure", () => {
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
      assert.ok(
        ((t: BaseType | undefined) => {
          if (!t || t.kind !== "non-terminal") return false;
          return typesLitEq(t.lft, t.rgt);
        })(ty),
      );
    });
  });
});
