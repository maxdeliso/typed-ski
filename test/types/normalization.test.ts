import { describe, it } from "../util/test_shim.ts";
import assert from "node:assert/strict";

import { normalize } from "../../lib/types/normalization.ts";
import {
  arrow,
  type BaseType,
  mkTypeVariable,
  typeApp,
} from "../../lib/types/types.ts";
import { forall as mkUniversal } from "../../lib/types/systemF.ts";

function assertIsTypeVar(
  bt: BaseType,
): asserts bt is { kind: "type-var"; typeName: string } {
  assert.equal(bt.kind, "type-var", "expected kind 'type-var'");
}

describe("type-normalization edge cases", () => {
  /* single type variable */
  it("single type variable stays a variable", () => {
    const a = mkTypeVariable("a");
    const out = normalize(a);

    assert.strictEqual(out.kind, "type-var");
    if (out.kind === "type-var") {
      assert.match(out.typeName, /^[a-z]/);
    }
  });

  /* repeated variable inside nested arrows */
  it("nested arrow with repeated vars keeps names aligned", () => {
    const repeated = arrow(
      arrow(mkTypeVariable("a"), mkTypeVariable("a")),
      arrow(mkTypeVariable("a"), mkTypeVariable("a")),
    );
    const out = normalize(repeated);

    if (
      out.kind === "non-terminal" &&
      out.lft.kind === "non-terminal" &&
      out.rgt.kind === "non-terminal"
    ) {
      const lName = out.lft.lft.kind === "type-var" ? out.lft.lft.typeName : "";
      const rName = out.rgt.lft.kind === "type-var" ? out.rgt.lft.typeName : "";
      assert.strictEqual(lName, rName);
      assertIsTypeVar(out.lft.rgt);
      assert.strictEqual(out.lft.rgt.typeName, lName);
      assertIsTypeVar(out.rgt.rgt);
      assert.strictEqual(out.rgt.rgt.typeName, rName);
    } else {
      assert.fail("expected nested arrow structure");
    }
  });

  /* forall a. a → a */
  it("quantified type gets fresh binder", () => {
    const ty = mkUniversal(
      "a",
      arrow(mkTypeVariable("a"), mkTypeVariable("a")),
    );
    const out = normalize(ty);

    assert.strictEqual(out.kind, "forall");
    if (
      out.kind === "forall" &&
      out.body.kind === "non-terminal" &&
      out.body.lft.kind === "type-var" &&
      out.body.rgt.kind === "type-var"
    ) {
      assert.strictEqual(out.body.lft.typeName, out.body.rgt.typeName);
      assert.strictEqual(out.body.lft.typeName, out.typeVar);
    } else {
      assert.fail("expected forall with arrow body");
    }
  });

  /* nested foralls ∀a. ∀b. a → b → a */
  it("nested forall bindings stay distinct", () => {
    const ty = mkUniversal(
      "a",
      mkUniversal(
        "b",
        arrow(
          mkTypeVariable("a"),
          arrow(mkTypeVariable("b"), mkTypeVariable("a")),
        ),
      ),
    );
    const out = normalize(ty);

    if (
      out.kind === "forall" &&
      out.body.kind === "forall" &&
      out.body.body.kind === "non-terminal" &&
      out.body.body.rgt.kind === "non-terminal"
    ) {
      const vOuter = out.typeVar;
      const vInner = out.body.typeVar;
      assert.notStrictEqual(vOuter, vInner);

      const firstArg = out.body.body.lft;
      const secondArg = out.body.body.rgt.lft;
      const retArg = out.body.body.rgt.rgt;

      assert.strictEqual(firstArg.kind, "type-var");
      if (firstArg.kind === "type-var") {
        assert.strictEqual(firstArg.typeName, vOuter);
      }

      assert.strictEqual(secondArg.kind, "type-var");
      if (secondArg.kind === "type-var") {
        assert.strictEqual(secondArg.typeName, vInner);
      }

      assert.strictEqual(retArg.kind, "type-var");
      if (retArg.kind === "type-var")
        assert.strictEqual(retArg.typeName, vOuter);
    } else {
      assert.fail("unexpected structure after normalization");
    }
  });

  /* (∀a. a→a) → (∀a. a→a) — distinct scopes */
  it("same variable names in different scopes normalise differently", () => {
    const ty = arrow(
      mkUniversal("a", arrow(mkTypeVariable("a"), mkTypeVariable("a"))),
      mkUniversal("a", arrow(mkTypeVariable("a"), mkTypeVariable("a"))),
    );
    const out = normalize(ty);

    if (
      out.kind === "non-terminal" &&
      out.lft.kind === "forall" &&
      out.rgt.kind === "forall"
    ) {
      const vLeft = out.lft.typeVar;
      const vRight = out.rgt.typeVar;
      assert.notStrictEqual(vLeft, vRight);

      const checkSide = (sideVar: string, body: typeof out.lft.body) => {
        if (
          body.kind === "non-terminal" &&
          body.lft.kind === "type-var" &&
          body.rgt.kind === "type-var"
        ) {
          assert.strictEqual(body.lft.typeName, sideVar);
          assert.strictEqual(body.rgt.typeName, sideVar);
        } else {
          assert.fail("expected arrow body with matching vars");
        }
      };

      checkSide(vLeft, out.lft.body);
      checkSide(vRight, out.rgt.body);
    } else {
      assert.fail("expected arrow whose sides are forall");
    }
  });

  /* type-app: List a, Result E T */
  it("normalises type application recursively", () => {
    const listA = typeApp(mkTypeVariable("List"), mkTypeVariable("a"));
    const out = normalize(listA);

    assert.strictEqual(out.kind, "type-app");
    if (out.kind === "type-app") {
      assert.strictEqual(out.fn.kind, "type-var");
      assert.strictEqual(out.arg.kind, "type-var");
      if (out.fn.kind === "type-var" && out.arg.kind === "type-var") {
        assert.match(out.fn.typeName, /^[a-z]/);
        assert.match(out.arg.typeName, /^[a-z]/);
      }
    }
  });

  it("normalises nested type applications and aligns variables", () => {
    const a = mkTypeVariable("a");
    const resultAT = typeApp(typeApp(mkTypeVariable("Result"), a), a);
    const out = normalize(resultAT);

    assert.strictEqual(out.kind, "type-app");
    if (out.kind === "type-app") {
      assert.strictEqual(out.fn.kind, "type-app");
      if (out.fn.kind === "type-app") {
        assert.strictEqual(out.fn.fn.kind, "type-var");
        assert.strictEqual(out.fn.arg.kind, "type-var");
        assert.strictEqual(out.arg.kind, "type-var");
        const fnArg = out.fn.arg.kind === "type-var" ? out.fn.arg.typeName : "";
        const topArg = out.arg.kind === "type-var" ? out.arg.typeName : "";
        assert.strictEqual(
          fnArg,
          topArg,
          "repeated 'a' should get same canonical name",
        );
      }
    }
  });
});
