import { expect } from "chai";

import {
  mkSystemFAbs,
  mkSystemFApp,
  mkSystemFTAbs,
  mkSystemFTypeApp,
  mkSystemFVar,
  type SystemFTerm,
} from "../../lib/terms/systemF.ts";

import { arrow, mkTypeVariable } from "../../lib/types/types.ts";
import { unparseType } from "../../lib/parser/type.ts";
import {
  emptySystemFContext,
  eraseSystemF,
  forall,
  typecheckSystemF,
} from "../../lib/types/systemF.ts";

import { parseSystemF } from "../../lib/parser/systemFTerm.ts";

Deno.test("System F type-checker and helpers", async (t) => {
  await t.step("positive cases", async (t) => {
    await t.step("polymorphic identity", () => {
      const id: SystemFTerm = mkSystemFTAbs(
        "X",
        mkSystemFAbs("x", mkTypeVariable("X"), mkSystemFVar("x")),
      );
      const [ty] = typecheckSystemF(emptySystemFContext(), id);
      expect(ty.kind).to.equal("forall");
      if (
        ty.kind === "forall" &&
        ty.body.kind === "non-terminal" &&
        ty.body.lft.kind === "type-var" &&
        ty.body.rgt.kind === "type-var"
      ) {
        expect(ty.typeVar).to.equal("X");
        expect(ty.body.lft.typeName).to.equal("X");
        expect(ty.body.rgt.typeName).to.equal("X");
      }
    });

    await t.step("K combinator", () => {
      const K: SystemFTerm = mkSystemFTAbs(
        "X",
        mkSystemFTAbs(
          "Y",
          mkSystemFAbs(
            "x",
            mkTypeVariable("X"),
            mkSystemFAbs("y", mkTypeVariable("Y"), mkSystemFVar("x")),
          ),
        ),
      );
      const [ty] = typecheckSystemF(emptySystemFContext(), K);
      expect(ty.kind).to.equal("forall");
      expect(unparseType(ty)).to.match(/#X->.*#Y->.*X->\(Y->X\)/);
    });

    await t.step("type application", () => {
      const id = mkSystemFTAbs(
        "X",
        mkSystemFAbs("x", mkTypeVariable("X"), mkSystemFVar("x")),
      );
      const term = mkSystemFApp(
        mkSystemFTypeApp(id, mkTypeVariable("A")),
        mkSystemFVar("a"),
      );

      let ctx = emptySystemFContext();
      ctx = {
        ...ctx,
        termCtx: (() => {
          const newCtx = new Map(ctx.termCtx);
          newCtx.set("a", mkTypeVariable("A"));
          return newCtx;
        })(),
      };

      const [ty] = typecheckSystemF(ctx, term);
      expect(ty.kind).to.equal("type-var");
      if (ty.kind === "type-var") expect(ty.typeName).to.equal("A");
    });

    await t.step("S combinator", () => {
      const S: SystemFTerm = mkSystemFTAbs(
        "A",
        mkSystemFTAbs(
          "B",
          mkSystemFTAbs(
            "C",
            mkSystemFAbs(
              "x",
              arrow(
                mkTypeVariable("A"),
                arrow(mkTypeVariable("B"), mkTypeVariable("C")),
              ),
              mkSystemFAbs(
                "y",
                arrow(mkTypeVariable("A"), mkTypeVariable("B")),
                mkSystemFAbs(
                  "z",
                  mkTypeVariable("A"),
                  mkSystemFApp(
                    mkSystemFApp(mkSystemFVar("x"), mkSystemFVar("z")),
                    mkSystemFApp(mkSystemFVar("y"), mkSystemFVar("z")),
                  ),
                ),
              ),
            ),
          ),
        ),
      );
      const [ty] = typecheckSystemF(emptySystemFContext(), S);
      expect(unparseType(ty))
        .to.equal("#A->#B->#C->((A->(B->C))->((A->B)->(A->C)))");
    });
  });

  /* ──────────────────────────  negative cases  ────────────────────────── */
  await t.step("negative cases", async (t) => {
    await t.step("unbound variable", () => {
      const term = mkSystemFVar("a");
      expect(() => typecheckSystemF(emptySystemFContext(), term))
        .to.throw(/unknown variable/);
    });

    await t.step("apply non-arrow", () => {
      let ctx = emptySystemFContext();
      ctx = {
        ...ctx,
        termCtx: (() => {
          const newCtx = new Map(ctx.termCtx);
          newCtx.set("a", mkTypeVariable("A"));
          return newCtx;
        })(),
      };
      ctx = {
        ...ctx,
        termCtx: (() => {
          const newCtx = new Map(ctx.termCtx);
          newCtx.set("b", mkTypeVariable("B"));
          return newCtx;
        })(),
      };
      const term = mkSystemFApp(mkSystemFVar("a"), mkSystemFVar("b"));
      expect(() => typecheckSystemF(ctx, term))
        .to.throw(/expected an arrow type/);
    });

    await t.step("type-apply non-universal", () => {
      let ctx = emptySystemFContext();
      ctx = {
        ...ctx,
        termCtx: (() => {
          const newCtx = new Map(ctx.termCtx);
          newCtx.set("a", mkTypeVariable("A"));
          return newCtx;
        })(),
      };
      const term = mkSystemFTypeApp(mkSystemFVar("a"), mkTypeVariable("B"));
      expect(() => typecheckSystemF(ctx, term))
        .to.throw(/universal type/);
    });

    await t.step("argument type mismatch", () => {
      const f = mkSystemFAbs("x", mkTypeVariable("A"), mkSystemFVar("x"));
      let ctx = emptySystemFContext();
      ctx = {
        ...ctx,
        termCtx: (() => {
          const newCtx = new Map(ctx.termCtx);
          newCtx.set("f", arrow(mkTypeVariable("A"), mkTypeVariable("A")));
          return newCtx;
        })(),
      };
      ctx = {
        ...ctx,
        termCtx: (() => {
          const newCtx = new Map(ctx.termCtx);
          newCtx.set("a", mkTypeVariable("B"));
          return newCtx;
        })(),
      };
      const term = mkSystemFApp(f, mkSystemFVar("a"));
      expect(() => typecheckSystemF(ctx, term))
        .to.throw(/function argument type mismatch/);
    });

    await t.step("self-application of non-arrow", () => {
      const term = mkSystemFAbs(
        "x",
        mkTypeVariable("X"),
        mkSystemFApp(mkSystemFVar("x"), mkSystemFVar("x")),
      );
      expect(() => typecheckSystemF(emptySystemFContext(), term))
        .to.throw(/expected an arrow type/);
    });

    await t.step(
      "function argument type mismatch with non-equivalent forall types",
      () => {
        // Create a function expecting #X->X->X
        const f = mkSystemFAbs(
          "x",
          forall("X", arrow(mkTypeVariable("X"), mkTypeVariable("X"))),
          mkSystemFVar("x"),
        );
        // Create an argument with #Y->Y->Z (different structure, not alpha-equivalent)
        const arg = mkSystemFTAbs(
          "Y",
          mkSystemFAbs(
            "y",
            mkTypeVariable("Y"),
            mkSystemFVar("z"), // Different body structure
          ),
        );
        let ctx = emptySystemFContext();
        ctx = {
          ...ctx,
          termCtx: (() => {
            const newCtx = new Map(ctx.termCtx);
            newCtx.set("z", mkTypeVariable("Z"));
            return newCtx;
          })(),
        };
        ctx = {
          ...ctx,
          termCtx: (() => {
            const newCtx = new Map(ctx.termCtx);
            newCtx.set(
              "f",
              arrow(
                forall("X", arrow(mkTypeVariable("X"), mkTypeVariable("X"))),
                mkTypeVariable("A"),
              ),
            );
            return newCtx;
          })(),
        };
        const term = mkSystemFApp(f, arg);
        // This should trigger the normalization path (both are forall) but fail after normalization
        expect(() => typecheckSystemF(ctx, term))
          .to.throw(/function argument type mismatch/);
      },
    );

    await t.step(
      "match expression must be elaborated before typechecking",
      () => {
        const matchTerm: SystemFTerm = {
          kind: "systemF-match",
          scrutinee: mkSystemFVar("x"),
          returnType: mkTypeVariable("T"),
          arms: [
            {
              constructorName: "Some",
              params: ["val"],
              body: mkSystemFVar("val"),
            },
          ],
        };
        expect(() => typecheckSystemF(emptySystemFContext(), matchTerm))
          .to.throw(/match must be elaborated before typechecking/);
      },
    );
  });

  /* ─────────────────  parser / pretty-printer round-trip  ──────────────── */
  await t.step("integration with parser & printer", () => {
    const src = "#X=> \\x: X => x";
    const [lit, term] = parseSystemF(src);
    const [ty] = typecheckSystemF(emptySystemFContext(), term);
    expect(unparseType(ty)).to.match(/#X->.*X->X/);
    expect(lit.replace(/\s+/g, "")).to.equal(src.replace(/\s+/g, ""));
  });

  await t.step("eraseSystemF", async (t) => {
    await t.step("erases simple polymorphic id", () => {
      const term = mkSystemFTAbs(
        "X",
        mkSystemFAbs("x", mkTypeVariable("X"), mkSystemFVar("x")),
      );
      const er = eraseSystemF(term);
      expect(er.kind).to.equal("lambda-abs");
      if (er.kind === "lambda-abs") {
        expect(er.name).to.equal("x");
        expect(er.body.kind).to.equal("lambda-var");
      }
    });

    await t.step("erases nested type applications", () => {
      const poly = mkSystemFTAbs(
        "X",
        mkSystemFTAbs(
          "Y",
          mkSystemFAbs(
            "f",
            arrow(mkTypeVariable("X"), mkTypeVariable("Y")),
            mkSystemFAbs(
              "x",
              mkTypeVariable("X"),
              mkSystemFApp(mkSystemFVar("f"), mkSystemFVar("x")),
            ),
          ),
        ),
      );
      const applied = mkSystemFTypeApp(
        mkSystemFTypeApp(poly, mkTypeVariable("int")),
        mkTypeVariable("bool"),
      );
      const er = eraseSystemF(applied);
      expect(er.kind).to.equal("lambda-abs");
      if (er.kind === "lambda-abs") {
        expect(er.name).to.equal("f");
      }
    });
  });

  await t.step("typechecker misc edge-cases", async (t) => {
    await t.step("nested type abstractions (K)", () => {
      const term = mkSystemFTAbs(
        "X",
        mkSystemFTAbs(
          "Y",
          mkSystemFAbs(
            "x",
            mkTypeVariable("X"),
            mkSystemFAbs("y", mkTypeVariable("Y"), mkSystemFVar("x")),
          ),
        ),
      );
      const [ty] = typecheckSystemF(emptySystemFContext(), term);
      expect(ty.kind).to.equal("forall");
      if (ty.kind === "forall") expect(ty.body.kind).to.equal("forall");
    });

    await t.step("type-checks under non-empty context", () => {
      let ctx = emptySystemFContext();
      ctx = {
        ...ctx,
        termCtx: (() => {
          const newCtx = new Map(ctx.termCtx);
          newCtx.set("x", mkTypeVariable("A"));
          return newCtx;
        })(),
      };
      ctx = {
        ...ctx,
        termCtx: (() => {
          const newCtx = new Map(ctx.termCtx);
          newCtx.set("f", arrow(mkTypeVariable("A"), mkTypeVariable("B")));
          return newCtx;
        })(),
      };
      const term = mkSystemFApp(mkSystemFVar("f"), mkSystemFVar("x"));
      const [ty] = typecheckSystemF(ctx, term);
      expect(ty.kind).to.equal("type-var");
      if (ty.kind === "type-var") expect(ty.typeName).to.equal("B");
    });

    await t.step("combined term & type application", () => {
      const polyId = mkSystemFTAbs(
        "X",
        mkSystemFAbs("x", mkTypeVariable("X"), mkSystemFVar("x")),
      );
      const term = mkSystemFApp(
        mkSystemFTypeApp(polyId, mkTypeVariable("A")),
        mkSystemFVar("y"),
      );

      let ctx = emptySystemFContext();
      ctx = {
        ...ctx,
        termCtx: (() => {
          const newCtx = new Map(ctx.termCtx);
          newCtx.set("y", mkTypeVariable("A"));
          return newCtx;
        })(),
      };

      const [ty] = typecheckSystemF(ctx, term);
      expect(ty.kind).to.equal("type-var");
      if (ty.kind === "type-var") expect(ty.typeName).to.equal("A");
    });
  });
});
