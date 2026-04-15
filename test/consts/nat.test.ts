import { describe, it } from "../util/test_shim.ts";
import assert from "node:assert/strict";
import {
  makeUntypedBinNumeral,
  makeUntypedChurchNumeral,
  skiToUntyped,
} from "../../lib/consts/nat.ts";
import { SKITerminalSymbol } from "../../lib/ski/terminal.ts";

describe("nat constants utilities - coverage", () => {
  it("makeUntypedChurchNumeral edge cases", () => {
    assert.throws(() => makeUntypedChurchNumeral(-1n), {
      name: "RangeError",
      message: "Nat literals must be non-negative",
    });

    // Test 0, 1, 2 to cover different ChurchN outputs
    const church0 = makeUntypedChurchNumeral(0n);
    assert.strictEqual(church0.kind, "non-terminal");

    const church1 = makeUntypedChurchNumeral(1n);
    assert.strictEqual(church1.kind, "lambda-abs");

    const church2 = makeUntypedChurchNumeral(2n);
    assert.strictEqual(church2.kind, "non-terminal");
  });

  it("makeUntypedBinNumeral edge cases", () => {
    assert.throws(() => makeUntypedBinNumeral(-1n), {
      name: "RangeError",
      message: "Nat literals must be non-negative",
    });

    const bin0 = makeUntypedBinNumeral(0n);
    assert.deepStrictEqual(bin0, { kind: "lambda-var", name: "BZ" });

    const bin1 = makeUntypedBinNumeral(1n); // B1 BZ
    assert.strictEqual(bin1.kind, "non-terminal");

    const bin2 = makeUntypedBinNumeral(2n); // B0 (B1 BZ)
    assert.strictEqual(bin2.kind, "non-terminal");
  });

  it("terminalToLambda unknown terminal", () => {
    // SPrime is not handled by terminalToLambda
    const expr = { kind: "terminal" as const, sym: SKITerminalSymbol.SPrime };
    assert.throws(() => skiToUntyped(expr), /Unknown SKI terminal/);
  });
});
