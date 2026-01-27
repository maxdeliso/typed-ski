import { assert, expect } from "chai";

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

Deno.test("type-normalization edge cases", async (t) => {
  /* single type variable */
  await t.step("single type variable stays a variable", () => {
    const a = mkTypeVariable("a");
    const out = normalize(a);

    expect(out.kind).to.equal("type-var");
    if (out.kind === "type-var") {
      expect(out.typeName).to.match(/^[a-z]/);
    }
  });

  /* repeated variable inside nested arrows */
  await t.step("nested arrow with repeated vars keeps names aligned", () => {
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
      expect(lName).to.equal(rName);
      assertIsTypeVar(out.lft.rgt);
      expect(out.lft.rgt.typeName).to.equal(lName);
      assertIsTypeVar(out.rgt.rgt);
      expect(out.rgt.rgt.typeName).to.equal(rName);
    } else {
      expect.fail("expected nested arrow structure");
    }
  });

  /* forall a. a → a */
  await t.step("quantified type gets fresh binder", () => {
    const ty = mkUniversal(
      "a",
      arrow(mkTypeVariable("a"), mkTypeVariable("a")),
    );
    const out = normalize(ty);

    expect(out.kind).to.equal("forall");
    if (
      out.kind === "forall" &&
      out.body.kind === "non-terminal" &&
      out.body.lft.kind === "type-var" &&
      out.body.rgt.kind === "type-var"
    ) {
      expect(out.body.lft.typeName).to.equal(out.body.rgt.typeName);
      expect(out.body.lft.typeName).to.equal(out.typeVar);
    } else {
      expect.fail("expected forall with arrow body");
    }
  });

  /* nested foralls ∀a. ∀b. a → b → a */
  await t.step("nested forall bindings stay distinct", () => {
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
      expect(vOuter).not.to.equal(vInner);

      const firstArg = out.body.body.lft;
      const secondArg = out.body.body.rgt.lft;
      const retArg = out.body.body.rgt.rgt;

      expect(firstArg.kind).to.equal("type-var");
      if (firstArg.kind === "type-var") {
        expect(firstArg.typeName).to.equal(vOuter);
      }

      expect(secondArg.kind).to.equal("type-var");
      if (secondArg.kind === "type-var") {
        expect(secondArg.typeName).to.equal(vInner);
      }

      expect(retArg.kind).to.equal("type-var");
      if (retArg.kind === "type-var") expect(retArg.typeName).to.equal(vOuter);
    } else {
      expect.fail("unexpected structure after normalization");
    }
  });

  /* (∀a. a→a) → (∀a. a→a) — distinct scopes */
  await t.step(
    "same variable names in different scopes normalise differently",
    () => {
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
        expect(vLeft).not.to.equal(vRight);

        const checkSide = (sideVar: string, body: typeof out.lft.body) => {
          if (
            body.kind === "non-terminal" &&
            body.lft.kind === "type-var" &&
            body.rgt.kind === "type-var"
          ) {
            expect(body.lft.typeName).to.equal(sideVar);
            expect(body.rgt.typeName).to.equal(sideVar);
          } else {
            expect.fail("expected arrow body with matching vars");
          }
        };

        checkSide(vLeft, out.lft.body);
        checkSide(vRight, out.rgt.body);
      } else {
        expect.fail("expected arrow whose sides are forall");
      }
    },
  );

  /* type-app: List a, Result E T */
  await t.step("normalises type application recursively", () => {
    const listA = typeApp(mkTypeVariable("List"), mkTypeVariable("a"));
    const out = normalize(listA);

    expect(out.kind).to.equal("type-app");
    if (out.kind === "type-app") {
      expect(out.fn.kind).to.equal("type-var");
      expect(out.arg.kind).to.equal("type-var");
      if (out.fn.kind === "type-var" && out.arg.kind === "type-var") {
        expect(out.fn.typeName).to.match(/^[a-z]/);
        expect(out.arg.typeName).to.match(/^[a-z]/);
      }
    }
  });

  await t.step(
    "normalises nested type applications and aligns variables",
    () => {
      const a = mkTypeVariable("a");
      const resultAT = typeApp(typeApp(mkTypeVariable("Result"), a), a);
      const out = normalize(resultAT);

      expect(out.kind).to.equal("type-app");
      if (out.kind === "type-app") {
        expect(out.fn.kind).to.equal("type-app");
        if (out.fn.kind === "type-app") {
          expect(out.fn.fn.kind).to.equal("type-var");
          expect(out.fn.arg.kind).to.equal("type-var");
          expect(out.arg.kind).to.equal("type-var");
          const fnArg = out.fn.arg.kind === "type-var"
            ? out.fn.arg.typeName
            : "";
          const topArg = out.arg.kind === "type-var" ? out.arg.typeName : "";
          expect(fnArg).to.equal(
            topArg,
            "repeated 'a' should get same canonical name",
          );
        }
      }
    },
  );
});
