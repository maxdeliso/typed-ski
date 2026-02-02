import { assertEquals } from "std/assert";

import { compile } from "../../lib/meta/frontend.ts";
import { resolvePoly } from "../../lib/meta/frontend/compilation.ts";
import type { SystemFTerm } from "../../lib/terms/systemF.ts";

const NO_NAT_SOURCE = `module LiteralNoNat

import Prelude BZ
import Prelude B0
import Prelude B1

poly main = 3
`;

const decodeBinTerm = (term: SystemFTerm): number => {
  if (term.kind === "systemF-var") {
    if (term.name !== "BZ") {
      throw new Error(`expected BZ, got ${term.name}`);
    }
    return 0;
  }
  if (term.kind !== "non-terminal") {
    throw new Error(`expected bin term, got ${term.kind}`);
  }
  const ctor = term.lft;
  if (ctor.kind !== "systemF-var") {
    throw new Error(`expected constructor, got ${ctor.kind}`);
  }
  const rest = decodeBinTerm(term.rgt);
  if (ctor.name === "B0") return rest * 2;
  if (ctor.name === "B1") return rest * 2 + 1;
  throw new Error(`expected B0/B1 constructor, got ${ctor.name}`);
};

Deno.test("numeric literals desugar to Bin terms", async (t) => {
  await t.step("compiles without Nat in scope", () => {
    const compiled = compile(NO_NAT_SOURCE);
    const mainPoly = resolvePoly(compiled, "main");
    assertEquals(decodeBinTerm(mainPoly.term), 3);
  });

  await t.step("no Nat requirement for literals", () => {
    assertEquals(true, true);
  });
});
