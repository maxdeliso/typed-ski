import { test } from "node:test";
import { expect } from "../util/assertions.ts";
import {
  makeUntypedBinNumeral,
  makeUntypedChurchNumeral,
  skiToUntyped,
} from "../../lib/consts/nat.ts";
import { SKITerminalSymbol } from "../../lib/ski/terminal.ts";

test("nat constants utilities - coverage", async (t) => {
  await t.test("makeUntypedChurchNumeral edge cases", () => {
    expect(() => makeUntypedChurchNumeral(-1n)).to.throw(
      RangeError,
      "Nat literals must be non-negative",
    );

    // Test 0, 1, 2 to cover different ChurchN outputs
    const church0 = makeUntypedChurchNumeral(0n);
    expect(church0.kind).to.equal("non-terminal");

    const church1 = makeUntypedChurchNumeral(1n);
    expect(church1.kind).to.equal("lambda-abs");

    const church2 = makeUntypedChurchNumeral(2n);
    expect(church2.kind).to.equal("non-terminal");
  });

  await t.test("makeUntypedBinNumeral edge cases", () => {
    expect(() => makeUntypedBinNumeral(-1n)).to.throw(
      RangeError,
      "Nat literals must be non-negative",
    );

    const bin0 = makeUntypedBinNumeral(0n);
    expect(bin0).to.deep.equal({ kind: "lambda-var", name: "BZ" });

    const bin1 = makeUntypedBinNumeral(1n); // B1 BZ
    expect(bin1.kind).to.equal("non-terminal");

    const bin2 = makeUntypedBinNumeral(2n); // B0 (B1 BZ)
    expect(bin2.kind).to.equal("non-terminal");
  });

  await t.test("terminalToLambda unknown terminal", () => {
    // SPrime is not handled by terminalToLambda
    const expr = { kind: "terminal" as const, sym: SKITerminalSymbol.SPrime };
    expect(() => skiToUntyped(expr)).to.throw("Unknown SKI terminal: P");
  });
});
