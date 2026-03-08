import { expect } from "chai";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateTrip } from "./tripHarness.ts";
import { UnChurchNumber } from "../../lib/ski/church.ts";
import { loadInput } from "./fileLoader.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

Deno.test("TripHarness", async (t) => {
  await t.step("includeNat flag allows using Nat module", async () => {
    const source = loadInput("includeNat.trip", __dirname);

    const result = await evaluateTrip(source, {
      includeNat: true,
      includeBin: true,
    });
    const number = await UnChurchNumber(result);

    expect(number).to.equal(2n);
  });
});
