import { expect } from "npm:chai";

import { mkUntypedAbs, mkVar, typelessApp } from "../../lib/terms/lambda.ts";
import { inferType, substituteType } from "../../lib/types/inference.ts";
import { arrow, mkTypeVariable, typesLitEq } from "../../lib/types/types.ts";

Deno.test("Type inference utilities", async (t) => {
  await t.step("substituteType", async (t) => {
    await t.step("replaces a variable with another type", () => {
      const a = mkTypeVariable("a");
      const b = mkTypeVariable("b");
      const c = mkTypeVariable("c");

      const r1 = substituteType(a, a, b);
      expect(typesLitEq(r1, b)).to.equal(true);

      const r2 = substituteType(c, a, b);
      expect(typesLitEq(r2, c)).to.equal(true);

      const r3 = substituteType(arrow(a, c), a, b);
      expect(typesLitEq(r3, arrow(b, c))).to.equal(true);
    });

    await t.step("handles substitutions in complex arrows", () => {
      const a = mkTypeVariable("a");
      const b = mkTypeVariable("b");
      const c = mkTypeVariable("c");

      const complex = arrow(arrow(a, b), c);
      const out = substituteType(complex, a, c);

      expect(typesLitEq(out, arrow(arrow(c, b), c))).to.equal(true);
    });

    await t.step("handles deeply nested substitutions", () => {
      const a = mkTypeVariable("a");
      const b = mkTypeVariable("b");

      const nested = arrow(arrow(a, a), arrow(a, a));
      const out = substituteType(nested, a, b);

      expect(typesLitEq(out, arrow(arrow(b, b), arrow(b, b)))).to.equal(true);
    });
  });

  await t.step("inferType", async (t) => {
    await t.step("infers type for a simple identity function", () => {
      const id = mkUntypedAbs("x", mkVar("x"));
      const [, ty] = inferType(id);

      expect(ty.kind).to.equal("non-terminal");
    });

    await t.step("infers arrow type with matching ends", () => {
      const id = mkUntypedAbs("x", mkVar("x"));
      const [, ty] = inferType(id);

      if (
        ty.kind === "non-terminal" &&
        ty.lft.kind === "type-var" &&
        ty.rgt.kind === "type-var"
      ) {
        expect(ty.lft.typeName).to.equal(ty.rgt.typeName);
      }
    });

    await t.step("infers type of the application combinator", () => {
      const appComb = mkUntypedAbs(
        "f",
        mkUntypedAbs("x", typelessApp(mkVar("f"), mkVar("x"))),
      );
      const [, ty] = inferType(appComb);

      expect(ty.kind).to.equal("non-terminal");
    });

    await t.step("handles a more complex term (K combinator)", () => {
      const kComb = mkUntypedAbs("x", mkUntypedAbs("y", mkVar("x")));
      const [, ty] = inferType(kComb);

      expect(ty.kind).to.equal("non-terminal");
    });
  });
});
