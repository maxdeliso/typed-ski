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
  reduceLets,
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

  await t.step("let bindings", async (t) => {
    await t.step("unannotated let typechecks (infers Nat)", () => {
      const [_, term] = parseSystemF("let x = 1 in x");
      expect(term.kind).to.equal("systemF-let");
      const [ty] = typecheckSystemF(emptySystemFContext(), term);
      expect(unparseType(ty)).to.match(/Nat/);
    });

    await t.step("annotated let with correct type typechecks", () => {
      const [_, term] = parseSystemF("let x : Nat = 1 in x");
      expect(term.kind).to.equal("non-terminal");
      const [ty] = typecheckSystemF(emptySystemFContext(), term);
      expect(unparseType(ty)).to.match(/Nat/);
    });

    await t.step("annotated let with incorrect type fails typecheck", () => {
      const [_, term] = parseSystemF("let x : Bool = 1 in x");
      expect(term.kind).to.equal("non-terminal");
      expect(() => typecheckSystemF(emptySystemFContext(), term))
        .to.throw(/function argument type mismatch/);
    });
  });

  await t.step("reduceLets", async (t) => {
    const hasSystemFLet = (term: SystemFTerm): boolean => {
      if (term.kind === "systemF-let") return true;
      switch (term.kind) {
        case "systemF-var":
          return false;
        case "systemF-abs":
          return hasSystemFLet(term.body);
        case "systemF-type-abs":
          return hasSystemFLet(term.body);
        case "systemF-type-app":
          return hasSystemFLet(term.term);
        case "non-terminal":
          return hasSystemFLet(term.lft) || hasSystemFLet(term.rgt);
        case "systemF-match":
          return (
            hasSystemFLet(term.scrutinee) ||
            term.arms.some((a) => hasSystemFLet(a.body))
          );
        default:
          return false;
      }
    };

    await t.step("expands unannotated let to App(Abs(...), value)", () => {
      const [_, term] = parseSystemF("let x = 1 in x");
      expect(term.kind).to.equal("systemF-let");

      const reduced = reduceLets(emptySystemFContext(), term);
      expect(hasSystemFLet(reduced)).to.equal(false);
      expect(reduced.kind).to.equal("non-terminal");
      if (reduced.kind === "non-terminal") {
        expect(reduced.lft.kind).to.equal("systemF-abs");
        if (reduced.lft.kind === "systemF-abs") {
          expect(reduced.lft.name).to.equal("x");
          expect(reduced.lft.body.kind).to.equal("systemF-var");
          if (reduced.lft.body.kind === "systemF-var") {
            expect(reduced.lft.body.name).to.equal("x");
          }
        }
        expect(reduced.rgt.kind).to.equal("systemF-var"); // literal 1
      }

      const [ty] = typecheckSystemF(emptySystemFContext(), reduced);
      expect(unparseType(ty)).to.match(/Nat/);
    });

    await t.step("expands nested lets and preserves type", () => {
      const [_, term] = parseSystemF("let x = 1 in let y = 2 in x");
      expect(term.kind).to.equal("systemF-let");

      const reduced = reduceLets(emptySystemFContext(), term);
      expect(hasSystemFLet(reduced)).to.equal(false);

      const [tyOriginal] = typecheckSystemF(emptySystemFContext(), term);
      const [tyReduced] = typecheckSystemF(emptySystemFContext(), reduced);
      expect(unparseType(tyReduced)).to.equal(unparseType(tyOriginal));
      expect(unparseType(tyReduced)).to.match(/Nat/);
    });

    await t.step("preserves type through reduceLets (let x = 1 in x)", () => {
      const [_, term] = parseSystemF("let x = 1 in x");
      const reduced = reduceLets(emptySystemFContext(), term);
      const [tyOrig] = typecheckSystemF(emptySystemFContext(), term);
      const [tyRed] = typecheckSystemF(emptySystemFContext(), reduced);
      expect(unparseType(tyRed)).to.equal(unparseType(tyOrig));
    });

    await t.step("traverses systemF-var (identity)", () => {
      const term = mkSystemFVar("x");
      const reduced = reduceLets(emptySystemFContext(), term);
      expect(reduced).to.deep.equal(term);
      expect(reduced.kind).to.equal("systemF-var");
    });

    await t.step("traverses systemF-abs (recurses body)", () => {
      const term = mkSystemFAbs(
        "y",
        mkTypeVariable("Nat"),
        mkSystemFVar("y"),
      );
      const reduced = reduceLets(emptySystemFContext(), term);
      expect(reduced.kind).to.equal("systemF-abs");
      expect((reduced as { name: string }).name).to.equal("y");
      expect((reduced as { body: SystemFTerm }).body.kind).to.equal(
        "systemF-var",
      );
    });

    await t.step("traverses systemF-type-abs (recurses body)", () => {
      const term = mkSystemFTAbs("X", mkSystemFVar("x"));
      const reduced = reduceLets(emptySystemFContext(), term);
      expect(reduced.kind).to.equal("systemF-type-abs");
      expect((reduced as { typeVar: string }).typeVar).to.equal("X");
      expect((reduced as { body: SystemFTerm }).body.kind).to.equal(
        "systemF-var",
      );
    });

    await t.step("traverses systemF-type-app (recurses term)", () => {
      const id = mkSystemFTAbs(
        "X",
        mkSystemFAbs("x", mkTypeVariable("X"), mkSystemFVar("x")),
      );
      const term = mkSystemFTypeApp(id, mkTypeVariable("Nat"));
      const reduced = reduceLets(emptySystemFContext(), term);
      expect(reduced.kind).to.equal("systemF-type-app");
      expect((reduced as { term: SystemFTerm }).term.kind).to.equal(
        "systemF-type-abs",
      );
      expect((reduced as { typeArg: { typeName: string } }).typeArg.typeName).to
        .equal("Nat");
    });

    await t.step("traverses non-terminal (recurses lft and rgt)", () => {
      const term = mkSystemFApp(mkSystemFVar("f"), mkSystemFVar("x"));
      const reduced = reduceLets(emptySystemFContext(), term);
      expect(reduced.kind).to.equal("non-terminal");
      expect((reduced as { lft: { name: string } }).lft.name).to.equal("f");
      expect((reduced as { rgt: { name: string } }).rgt.name).to.equal("x");
    });

    await t.step(
      "traverses systemF-match (recurses scrutinee and arm bodies)",
      () => {
        const term: SystemFTerm = {
          kind: "systemF-match",
          scrutinee: mkSystemFVar("m"),
          returnType: mkTypeVariable("T"),
          arms: [
            {
              constructorName: "A",
              params: [],
              body: mkSystemFVar("y"),
            },
          ],
        };
        const reduced = reduceLets(emptySystemFContext(), term);
        expect(reduced.kind).to.equal("systemF-match");
        expect((reduced as { scrutinee: { name: string } }).scrutinee.name).to
          .equal("m");
        const arm = (reduced as {
          arms: Array<{ constructorName: string; body: { name: string } }>;
        }).arms[0];
        expect(arm.constructorName).to.equal("A");
        expect(arm.body.name).to.equal("y");
      },
    );

    await t.step("let whose value is systemF-abs exercises abs branch", () => {
      const bodyUsesLet = parseSystemF("let x = (\\y : Nat => y) in x")[1];
      expect(bodyUsesLet.kind).to.equal("systemF-let");
      const value = (bodyUsesLet as { value: SystemFTerm }).value;
      expect(value.kind).to.equal("systemF-abs");
      const reduced = reduceLets(emptySystemFContext(), bodyUsesLet);
      expect(hasSystemFLet(reduced)).to.equal(false);
      const [ty] = typecheckSystemF(emptySystemFContext(), reduced);
      expect(unparseType(ty)).to.match(/Nat/);
    });
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
