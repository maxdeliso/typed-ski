import { describe, it } from "../util/test_shim.ts";
import assert from "node:assert/strict";
import rsexport, { type RandomSeed } from "random-seed";
import { randTerminal } from "../../lib/ski/generator.ts";
import { SKITerminalSymbol } from "../../lib/ski/terminal.ts";
const { create } = rsexport;

it("randTerminal - covers all possible terminals", () => {
  const rs: RandomSeed = create("test-seed");
  const seen = new Set<SKITerminalSymbol>();
  const expected = new Set(Object.values(SKITerminalSymbol));

  // With ~16 terminals, 1000 iterations is plenty to see them all
  for (let i = 0; i < 1000; i++) {
    const t = randTerminal(rs, { includeEffects: true });
    seen.add(t.sym);
  }

  for (const sym of expected) {
    assert.strictEqual(
      seen.has(sym),
      true,
      `Terminal ${sym} was never generated`,
    );
  }

  assert.strictEqual(
    seen.size,
    expected.size,
    "Generated more terminals than expected?",
  );
});

it("randTerminal - defaults to pure terminals", () => {
  const rs: RandomSeed = create("pure-only-seed");

  for (let i = 0; i < 1000; i++) {
    const t = randTerminal(rs);
    assert.notStrictEqual(t.sym, SKITerminalSymbol.ReadOne);
    assert.notStrictEqual(t.sym, SKITerminalSymbol.WriteOne);
  }
});
