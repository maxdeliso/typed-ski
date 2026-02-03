import { expect } from "chai";
import { evaluateTrip } from "./tripHarness.ts";
import { UnChurchNumber } from "../../lib/ski/church.ts";

Deno.test("TripHarness", async (t) => {
  await t.step("includeNat flag allows using Nat module", async () => {
    // This program uses the 'succ' function which is exported by the Nat module
    const source = `
      module Main
      import Nat succ
      import Nat zero
      export main

      poly main = succ (succ zero)
    `;

    const result = await evaluateTrip(source, { includeNat: true });
    const number = UnChurchNumber(result);

    expect(number).to.equal(2n);
  });
});
