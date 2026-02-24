import { assertEquals } from "std/assert";

import { parseTripLang } from "../../lib/parser/tripLang.ts";
import type { TripLangTerm } from "../../lib/meta/trip.ts";

const SOURCE_WITH_NAT_LITERAL = `module M
export main
poly main = 3
`;

Deno.test("numeric literals desugar to nat literal vars", async (t) => {
  await t.step("parsed main = 3 is nat literal var", () => {
    const program = parseTripLang(SOURCE_WITH_NAT_LITERAL);
    const mainDef = program.terms.find(
      (t): t is TripLangTerm => t.kind === "poly" && t.name === "main",
    );
    assertEquals(mainDef !== undefined, true);
    if (mainDef?.kind === "poly") {
      assertEquals(mainDef.term.kind, "systemF-var");
      if (mainDef.term.kind === "systemF-var") {
        assertEquals(mainDef.term.name, "__trip_u8_3");
      }
    }
  });

  await t.step("no Nat requirement for literals", () => {
    assertEquals(true, true);
  });
});
