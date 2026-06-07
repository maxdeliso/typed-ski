import { describe, it } from "../util/test_shim.ts";
import assert from "node:assert/strict";

import {
  arrow,
  arrows,
  getTypePolarity,
  mkTypeVariable,
  typeApp,
} from "../../lib/types/types.ts";
import { getMiniTypePolarity } from "../../lib/minicore/metadata.ts";
import { parseType, unparseType } from "../../lib/parser/type.ts";
import { parseSystemF, unparseSystemF } from "../../lib/parser/systemFTerm.ts";
import {
  typecheck,
  typecheckSystemF,
  emptySystemFContext,
} from "../../lib/types/systemF.ts";

describe("type polarity checks", () => {
  describe("BaseType Polarity", () => {
    it("classifies primitive types and type variables as positive", () => {
      const natTy = mkTypeVariable("Nat");
      const u8Ty = mkTypeVariable("U8");
      const aTy = mkTypeVariable("a");

      assert.strictEqual(getTypePolarity(natTy), "positive");
      assert.strictEqual(getTypePolarity(u8Ty), "positive");
      assert.strictEqual(getTypePolarity(aTy), "positive");
    });

    it("classifies arrow types as negative", () => {
      const natTy = mkTypeVariable("Nat");
      const fnTy = arrow(natTy, natTy);
      const complexFnTy = arrows(natTy, natTy, natTy);

      assert.strictEqual(getTypePolarity(fnTy), "negative");
      assert.strictEqual(getTypePolarity(complexFnTy), "negative");
    });

    it("classifies universal (forall) types as negative", () => {
      const forallTy: any = {
        kind: "forall",
        typeVar: "a",
        body: mkTypeVariable("a"),
      };

      assert.strictEqual(getTypePolarity(forallTy), "negative");
    });

    it("classifies type applications as positive", () => {
      const listTy = mkTypeVariable("List");
      const u8Ty = mkTypeVariable("U8");
      const listU8Ty = typeApp(listTy, u8Ty);

      assert.strictEqual(getTypePolarity(listU8Ty), "positive");
    });
  });

  describe("MiniType Polarity", () => {
    it("classifies values and data types as positive", () => {
      assert.strictEqual(getMiniTypePolarity({ kind: "nat" }), "positive");
      assert.strictEqual(getMiniTypePolarity({ kind: "u8" }), "positive");
      assert.strictEqual(getMiniTypePolarity({ kind: "bool" }), "positive");
      assert.strictEqual(getMiniTypePolarity({ kind: "unit" }), "positive");
      assert.strictEqual(
        getMiniTypePolarity({ kind: "data", id: 42, args: [] }),
        "positive",
      );
      assert.strictEqual(
        getMiniTypePolarity({ kind: "var", name: "a" }),
        "positive",
      );
    });

    it("classifies functions and universally quantified types as negative", () => {
      assert.strictEqual(
        getMiniTypePolarity({
          kind: "fn",
          params: [{ kind: "u8" }],
          result: { kind: "u8" },
        }),
        "negative",
      );
      assert.strictEqual(
        getMiniTypePolarity({
          kind: "forall",
          params: ["a"],
          body: { kind: "var", name: "a" },
        }),
        "negative",
      );
    });
  });

  describe("Thunk and Force parsing & typechecking", () => {
    it("parses and unparses thunk types", () => {
      const [lit, ty] = parseType("[* U8 -> U8 *]");
      assert.strictEqual(lit, "[* U8->U8 *]");
      assert.strictEqual(ty.kind, "thunk");
      assert.strictEqual(unparseType(ty), "[* (U8->U8) *]");
    });

    it("parses and unparses thunk and force terms", () => {
      const [lit, term] = parseSystemF("[* \\x : U8 => x *]");
      assert.strictEqual(lit, "[* \\x:U8=>x *]");
      assert.strictEqual(term.kind, "systemF-thunk");
      assert.strictEqual(unparseSystemF(term), "[* \\x:U8=>x *]");

      const [forceLit, forceTerm] = parseSystemF("*! x");
      assert.strictEqual(forceLit, "*! x");
      assert.strictEqual(forceTerm.kind, "systemF-force");
      assert.strictEqual(unparseSystemF(forceTerm), "*! x");
    });

    it("typechecks thunk and force terms correctly", () => {
      // 1. Thunking a function type (negative) is positive.
      const [, term] = parseSystemF("[* \\x : U8 => x *]");
      const ty = typecheck(term);
      assert.strictEqual(ty.kind, "thunk");
      assert.strictEqual(unparseType(ty), "[* (U8->U8) *]");

      // 2. Forcing a thunk type returns the inner negative type.
      const [, forceTerm] = parseSystemF("*! [* \\x : U8 => x *]");
      const innerTy = typecheck(forceTerm);
      assert.strictEqual(innerTy.kind, "non-terminal");
      assert.strictEqual(unparseType(innerTy), "(U8->U8)");
    });

    it("fails typechecking for polarity mismatch", () => {
      // Thunking a positive type (Nat is positive, not negative/computation)
      const [, badThunk] = parseSystemF("[* x *]");
      const ctx = emptySystemFContext();
      ctx.termCtx.set("x", mkTypeVariable("Nat"));
      assert.throws(
        () => typecheckSystemF(ctx, badThunk),
        /expected negative computation type inside thunk/,
      );

      // Forcing a non-thunk type
      const [, badForce] = parseSystemF("*! x");
      const ctx2 = emptySystemFContext();
      ctx2.termCtx.set("x", mkTypeVariable("Nat"));
      assert.throws(
        () => typecheckSystemF(ctx2, badForce),
        /expected thunk type to force/,
      );
    });
  });

  describe("Lazy Streams", () => {
    it("typechecks a lazy stream tail force expression", () => {
      // Stream U8 = Pair U8 [* U8 -> Stream U8 *]
      // We typecheck forcing the tail t : [* U8 -> Stream U8 *] and applying a dummy argument
      const ctx = emptySystemFContext();
      const streamU8Ty = typeApp(
        mkTypeVariable("Stream"),
        mkTypeVariable("U8"),
      );
      ctx.termCtx.set("t", {
        kind: "thunk",
        body: arrow(mkTypeVariable("U8"), streamU8Ty),
      });

      const [, forceTerm] = parseSystemF("(*! t) #u8(0)");
      const [ty] = typecheckSystemF(ctx, forceTerm);
      assert.strictEqual(unparseType(ty), "Stream U8");
    });
  });

  describe("Advanced Motivating Examples", () => {
    it("typechecks a lazy conditional selector (lazyChoose)", () => {
      // lazyChoose : Bool -> [* U8 -> U8 *] -> [* U8 -> U8 *] -> U8
      // lazyChoose = \c : Bool => \thenThunk : [* U8 -> U8 *] => \elseThunk : [* U8 -> U8 *] =>
      //   (c [U8 -> U8] (*! thenThunk) (*! elseThunk)) #u8(0)
      const ctx = emptySystemFContext();
      ctx.termCtx.set("c", {
        kind: "forall",
        typeVar: "B",
        body: arrow(
          mkTypeVariable("B"),
          arrow(mkTypeVariable("B"), mkTypeVariable("B")),
        ),
      }); // Church-encoded Bool
      ctx.termCtx.set("thenThunk", {
        kind: "thunk",
        body: arrow(mkTypeVariable("U8"), mkTypeVariable("U8")),
      });
      ctx.termCtx.set("elseThunk", {
        kind: "thunk",
        body: arrow(mkTypeVariable("U8"), mkTypeVariable("U8")),
      });

      const [, term] = parseSystemF(
        "(c [U8 -> U8] (*! thenThunk) (*! elseThunk)) #u8(0)",
      );
      const [ty] = typecheckSystemF(ctx, term);
      assert.strictEqual(unparseType(ty), "U8");
    });

    it("typechecks nested thunks and multiple forces", () => {
      // t : [* U8 -> [* U8 -> U8 *] *]
      // Term: *! ((*! t) #u8(0))
      const ctx = emptySystemFContext();
      ctx.termCtx.set("t", {
        kind: "thunk",
        body: arrow(mkTypeVariable("U8"), {
          kind: "thunk",
          body: arrow(mkTypeVariable("U8"), mkTypeVariable("U8")),
        }),
      });

      const [, term] = parseSystemF("*! ((*! t) #u8(0))");
      const [ty] = typecheckSystemF(ctx, term);
      assert.strictEqual(unparseType(ty), "(U8->U8)");
    });
  });
});
