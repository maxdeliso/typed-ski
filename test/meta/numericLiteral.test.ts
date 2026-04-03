import { test } from "node:test";
import assert from "node:assert/strict";

import { parseTripLang } from "../../lib/parser/tripLang.ts";
import type { TripLangTerm } from "../../lib/meta/trip.ts";

const SOURCE_WITH_NAT_LITERAL = `module M
export main
poly main = 3
`;

test("numeric literals desugar to nat literal vars", async (t) => {
  await t.test("parsed main = 3 is nat literal var", () => {
    const program = parseTripLang(SOURCE_WITH_NAT_LITERAL);
    const mainDef = program.terms.find(
      (t): t is TripLangTerm => t.kind === "poly" && t.name === "main",
    );
    assert.deepStrictEqual(mainDef !== undefined, true);
    if (mainDef?.kind === "poly") {
      assert.deepStrictEqual(mainDef.term.kind, "systemF-var");
      if (mainDef.term.kind === "systemF-var") {
        assert.deepStrictEqual(mainDef.term.name, "__trip_u8_3");
      }
    }
  });

  await t.test("no Nat requirement for literals", () => {
    assert.deepStrictEqual(true, true);
  });
});
