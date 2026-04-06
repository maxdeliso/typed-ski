import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DAG_TERMINAL_CHARS,
  dagCharToSym,
  fromDagWire,
  toDagWire,
} from "../../lib/ski/dagWire.ts";
import { apply, equivalent } from "../../lib/ski/expression.ts";
import { K, S, SKITerminalSymbol, term } from "../../lib/ski/terminal.ts";

test("dag wire round-trips shared application graphs", () => {
  const shared = apply(S, K);
  const expr = apply(shared, shared);

  assert.deepStrictEqual(toDagWire(expr), "S K @0,1 @2,2");
  assert.ok(equivalent(fromDagWire(toDagWire(expr)), expr));
});

test("dag wire encodes terminals and U8 literals", () => {
  for (const symbol of Object.values(SKITerminalSymbol)) {
    assert.ok(DAG_TERMINAL_CHARS.has(symbol));
    assert.deepStrictEqual(dagCharToSym(symbol), symbol);
    assert.deepStrictEqual(toDagWire(term(symbol)), symbol);
  }

  const compactByte = fromDagWire("U41");
  assert.deepStrictEqual(compactByte.kind, "u8");
  if (compactByte.kind !== "u8") {
    throw new Error("expected compact byte literal");
  }
  assert.deepStrictEqual(compactByte.value, 0x41);

  const sourceByte = fromDagWire("#u8(65)");
  assert.deepStrictEqual(sourceByte.kind, "u8");
  if (sourceByte.kind !== "u8") {
    throw new Error("expected source byte literal");
  }
  assert.deepStrictEqual(sourceByte.value, 65);
  assert.deepStrictEqual(toDagWire(sourceByte), "U41");
});

test("dag wire rejects malformed tokens", () => {
  assert.throws(() => fromDagWire(""), Error, "empty DAG");
  assert.throws(() => fromDagWire("#u8(256)"), Error, "invalid U8");
  assert.throws(() => fromDagWire("UXY"), Error, "invalid U8");
  assert.throws(() => fromDagWire("@0"), Error, "invalid app");
  assert.throws(() => fromDagWire("@0,0"), Error, "invalid app indices");
  assert.throws(() => fromDagWire("X"), Error, "invalid DAG token");
  assert.throws(() => dagCharToSym("?"), Error, "invalid DAG terminal: ?");
});
