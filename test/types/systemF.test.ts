import { describe, it } from "../util/test_shim.ts";
import assert from "node:assert/strict";

import {
  mkSystemFAbs,
  mkSystemFTAbs,
  mkSystemFTypeApp,
  mkSystemFVar,
  type SystemFTerm,
} from "../../lib/terms/systemF.ts";
import { mkSystemFApp } from "../util/ast.ts";

import { arrow, mkTypeVariable } from "../../lib/types/types.ts";
import { unparseType } from "../../lib/parser/type.ts";
import {
  emptySystemFContext,
  eraseSystemF,
  forall,
  reduceLets,
  typecheck,
  typecheckSystemF,
} from "../../lib/types/systemF.ts";

import { parseSystemF } from "../../lib/parser/systemFTerm.ts";
import { requiredAt } from "../util/required.ts";

const binSystemFContext = () => {
  const ctx = emptySystemFContext();
  const binTy = mkTypeVariable("Bin");
  const natTy = mkTypeVariable("Nat");
  const u8Ty = mkTypeVariable("U8");
  const boolTy = mkTypeVariable("Bool");
  ctx.termCtx.set("BZ", binTy);
  ctx.termCtx.set("B0", arrow(binTy, binTy));
  ctx.termCtx.set("B1", arrow(binTy, binTy));
  ctx.termCtx.set("Nat", natTy); // for nat literal vars
  ctx.termCtx.set("U8", u8Ty);
  ctx.termCtx.set("Bool", boolTy);
  return ctx;
};

describe("System F type-checker and helpers", () => {
  describe("positive cases", () => {
    it("typecheck wrapper uses emptySystemFContext(undefined)", () => {
      // Regression coverage: ensure the exported `typecheck()` wrapper is exercised
      // (it should delegate via emptySystemFContext(undefined)).
      const id: SystemFTerm = mkSystemFTAbs(
        "X",
        mkSystemFAbs("x", mkTypeVariable("X"), mkSystemFVar("x")),
      );
      const ty = typecheck(id);
      assert.strictEqual(ty.kind, "forall");
      if (
        ty.kind === "forall" &&
        ty.body.kind === "non-terminal" &&
        ty.body.lft.kind === "type-var" &&
        ty.body.rgt.kind === "type-var"
      ) {
        assert.strictEqual(ty.typeVar, "X");
        assert.strictEqual(ty.body.lft.typeName, "X");
        assert.strictEqual(ty.body.rgt.typeName, "X");
      }
    });

    it("polymorphic identity", () => {
      const id: SystemFTerm = mkSystemFTAbs(
        "X",
        mkSystemFAbs("x", mkTypeVariable("X"), mkSystemFVar("x")),
      );
      const [ty] = typecheckSystemF(emptySystemFContext(), id);
      assert.strictEqual(ty.kind, "forall");
      if (
        ty.kind === "forall" &&
        ty.body.kind === "non-terminal" &&
        ty.body.lft.kind === "type-var" &&
        ty.body.rgt.kind === "type-var"
      ) {
        assert.strictEqual(ty.typeVar, "X");
        assert.strictEqual(ty.body.lft.typeName, "X");
        assert.strictEqual(ty.body.rgt.typeName, "X");
      }
    });

    it("K combinator", () => {
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
      assert.strictEqual(ty.kind, "forall");
      assert.match(unparseType(ty), /#X->.*#Y->.*X->\(Y->X\)/);
    });

    it("type application", () => {
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
      assert.strictEqual(ty.kind, "type-var");
      if (ty.kind === "type-var") assert.strictEqual(ty.typeName, "A");
    });

    it("S combinator", () => {
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
      assert.strictEqual(
        unparseType(ty),
        "#A->#B->#C->((A->(B->C))->((A->B)->(A->C)))",
      );
    });
  });

  /* ──────────────────────────  negative cases  ────────────────────────── */
  describe("negative cases", () => {
    it("unbound variable", () => {
      const term = mkSystemFVar("a");
      assert.throws(() => typecheckSystemF(emptySystemFContext(), term), {
        message: /unknown variable/,
      });
    });

    it("apply non-arrow", () => {
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
      assert.throws(() => typecheckSystemF(ctx, term), {
        message: /expected an arrow type/,
      });
    });

    it("type-apply non-universal", () => {
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
      assert.throws(() => typecheckSystemF(ctx, term), {
        message: /universal type/,
      });
    });

    it("argument type mismatch", () => {
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
      assert.throws(() => typecheckSystemF(ctx, term), {
        message: /function argument type mismatch/,
      });
    });

    it("self-application of non-arrow", () => {
      const term = mkSystemFAbs(
        "x",
        mkTypeVariable("X"),
        mkSystemFApp(mkSystemFVar("x"), mkSystemFVar("x")),
      );
      assert.throws(() => typecheckSystemF(emptySystemFContext(), term), {
        message: /expected an arrow type/,
      });
    });

    it("function argument type mismatch with non-equivalent forall types", () => {
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
      assert.throws(() => typecheckSystemF(ctx, term), {
        message: /function argument type mismatch/,
      });
    });

    it("match expression must be elaborated before typechecking", () => {
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
      assert.throws(() => typecheckSystemF(emptySystemFContext(), matchTerm), {
        message: /match must be elaborated before typechecking/,
      });
    });
  });

  /* ─────────────────  parser / pretty-printer round-trip  ──────────────── */
  it("integration with parser & printer", () => {
    const src = "#X=> \\x: X => x";
    const [lit, term] = parseSystemF(src);
    const [ty] = typecheckSystemF(emptySystemFContext(), term);
    assert.match(unparseType(ty), /#X->.*X->X/);
    assert.strictEqual(lit.replace(/\s+/g, ""), src.replace(/\s+/g, ""));
  });

  describe("let bindings", () => {
    it("unannotated let typechecks (infers U8 for nat literal < 256)", () => {
      const [_, term] = parseSystemF("let x = 1 in x");
      assert.strictEqual(term.kind, "systemF-let");
      const [ty] = typecheckSystemF(binSystemFContext(), term);
      assert.match(unparseType(ty), /U8/);
    });

    it("annotated let with correct type typechecks", () => {
      const [_, term] = parseSystemF("let x : U8 = 1 in x");
      // Annotated let parses directly to App(Abs(...), value)
      assert.strictEqual(term.kind, "non-terminal");
      const [ty] = typecheckSystemF(binSystemFContext(), term);
      assert.match(unparseType(ty), /U8/);
    });

    it("annotated let with incorrect type fails typecheck", () => {
      const [_, term] = parseSystemF("let x : Bool = 1 in x");
      assert.strictEqual(term.kind, "non-terminal");
      assert.throws(() => typecheckSystemF(binSystemFContext(), term), {
        message: /function argument type mismatch/,
      });
    });
  });

  describe("reduceLets", () => {
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

    it("expands unannotated let to App(Abs(...), value)", () => {
      const [_, term] = parseSystemF("let x = 1 in x");
      assert.strictEqual(term.kind, "systemF-let");

      const reduced = reduceLets(binSystemFContext(), term);
      assert.strictEqual(hasSystemFLet(reduced), false);
      assert.strictEqual(reduced.kind, "non-terminal");
      if (reduced.kind === "non-terminal") {
        assert.strictEqual(reduced.lft.kind, "systemF-abs");
        if (reduced.lft.kind === "systemF-abs") {
          assert.strictEqual(reduced.lft.name, "x");
          assert.strictEqual(reduced.lft.body.kind, "systemF-var");
          if (reduced.lft.body.kind === "systemF-var") {
            assert.strictEqual(reduced.lft.body.name, "x");
          }
        }
        assert.ok(["systemF-var", "non-terminal"].includes(reduced.rgt.kind)); // literal 1
      }

      const [ty] = typecheckSystemF(binSystemFContext(), reduced);
      assert.match(unparseType(ty), /U8/);
    });

    it("expands nested lets and preserves type", () => {
      const [_, term] = parseSystemF("let x = 1 in let y = 2 in x");
      assert.strictEqual(term.kind, "systemF-let");

      const reduced = reduceLets(binSystemFContext(), term);
      assert.strictEqual(hasSystemFLet(reduced), false);

      const [tyOriginal] = typecheckSystemF(binSystemFContext(), term);
      const [tyReduced] = typecheckSystemF(binSystemFContext(), reduced);
      assert.strictEqual(unparseType(tyReduced), unparseType(tyOriginal));
      assert.match(unparseType(tyReduced), /U8/);
    });

    it("preserves type through reduceLets (let x = 1 in x)", () => {
      const [_, term] = parseSystemF("let x = 1 in x");
      const reduced = reduceLets(binSystemFContext(), term);
      const [tyOrig] = typecheckSystemF(binSystemFContext(), term);
      const [tyRed] = typecheckSystemF(binSystemFContext(), reduced);
      assert.strictEqual(unparseType(tyRed), unparseType(tyOrig));
    });

    it("traverses systemF-var (identity)", () => {
      const term = mkSystemFVar("x");
      const reduced = reduceLets(emptySystemFContext(), term);
      assert.strictEqual(reduced, term);
      assert.strictEqual(reduced.kind, "systemF-var");
    });

    it("traverses systemF-abs (recurses body)", () => {
      const term = mkSystemFAbs("y", mkTypeVariable("Bin"), mkSystemFVar("y"));
      const reduced = reduceLets(emptySystemFContext(), term);
      assert.strictEqual(reduced.kind, "systemF-abs");
      assert.strictEqual((reduced as any).name, "y");
      assert.strictEqual((reduced as any).body.kind, "systemF-var");
    });

    it("traverses systemF-type-abs (recurses body)", () => {
      const term = mkSystemFTAbs("X", mkSystemFVar("x"));
      const reduced = reduceLets(emptySystemFContext(), term);
      assert.strictEqual(reduced.kind, "systemF-type-abs");
      assert.strictEqual((reduced as any).typeVar, "X");
      assert.strictEqual((reduced as any).body.kind, "systemF-var");
    });

    it("traverses systemF-type-app (recurses term)", () => {
      const id = mkSystemFTAbs(
        "X",
        mkSystemFAbs("x", mkTypeVariable("X"), mkSystemFVar("x")),
      );
      const term = mkSystemFTypeApp(id, mkTypeVariable("Nat"));
      const reduced = reduceLets(emptySystemFContext(), term);
      assert.strictEqual(reduced.kind, "systemF-type-app");
      assert.strictEqual((reduced as any).term.kind, "systemF-type-abs");
      assert.strictEqual((reduced as any).typeArg.typeName, "Nat");
    });

    it("traverses non-terminal (recurses lft and rgt)", () => {
      const term = mkSystemFApp(mkSystemFVar("f"), mkSystemFVar("x"));
      const reduced = reduceLets(emptySystemFContext(), term);
      assert.strictEqual(reduced.kind, "non-terminal");
      assert.strictEqual((reduced as any).lft.name, "f");
      assert.strictEqual((reduced as any).rgt.name, "x");
    });

    it("traverses systemF-match (recurses scrutinee and arm bodies)", () => {
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
      assert.strictEqual(reduced.kind, "systemF-match");
      assert.strictEqual((reduced as any).scrutinee.name, "m");
      const arm = requiredAt(
        (reduced as any).arms,
        0,
        "expected first match arm",
      );
      assert.strictEqual((arm as any).constructorName, "A");
      assert.strictEqual((arm as any).body.name, "y");
    });

    it("let whose value is systemF-abs exercises abs branch", () => {
      const bodyUsesLet = parseSystemF("let x = (\\y : Bin => y) in x")[1];
      assert.strictEqual(bodyUsesLet.kind, "systemF-let");
      const value = (bodyUsesLet as any).value;
      assert.strictEqual(value.kind, "systemF-abs");
      const reduced = reduceLets(emptySystemFContext(), bodyUsesLet);
      assert.strictEqual(hasSystemFLet(reduced), false);
      const [ty] = typecheckSystemF(emptySystemFContext(), reduced);
      assert.match(unparseType(ty), /Bin/);
    });
  });

  describe("eraseSystemF", () => {
    it("erases simple polymorphic id", () => {
      const term = mkSystemFTAbs(
        "X",
        mkSystemFAbs("x", mkTypeVariable("X"), mkSystemFVar("x")),
      );
      const er = eraseSystemF(term);
      assert.strictEqual(er.kind, "lambda-abs");
      if (er.kind === "lambda-abs") {
        assert.strictEqual(er.name, "x");
        assert.strictEqual(er.body.kind, "lambda-var");
      }
    });

    it("erases nested type applications", () => {
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
      assert.strictEqual(er.kind, "lambda-abs");
      if (er.kind === "lambda-abs") {
        assert.strictEqual(er.name, "f");
      }
    });
  });

  describe("typechecker misc edge-cases", () => {
    it("nested type abstractions (K)", () => {
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
      assert.strictEqual(ty.kind, "forall");
      if (ty.kind === "forall") assert.strictEqual(ty.body.kind, "forall");
    });

    it("type-checks under non-empty context", () => {
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
      assert.strictEqual(ty.kind, "type-var");
      if (ty.kind === "type-var") assert.strictEqual(ty.typeName, "B");
    });

    it("combined term & type application", () => {
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
      assert.strictEqual(ty.kind, "type-var");
      if (ty.kind === "type-var") assert.strictEqual(ty.typeName, "A");
    });
  });
});
