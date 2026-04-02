import { assert, assertEquals, assertThrows } from "std/assert";
import {
  DAG_TERMINAL_CHARS,
  dagCharToSym,
  fromDagWire,
  toDagWire,
} from "../../lib/ski/dagWire.ts";
import { apply, equivalent } from "../../lib/ski/expression.ts";
import { K, S, SKITerminalSymbol, term } from "../../lib/ski/terminal.ts";

Deno.test("dag wire round-trips shared application graphs", () => {
  const shared = apply(S, K);
  const expr = apply(shared, shared);

  assertEquals(toDagWire(expr), "S K @0,1 @2,2");
  assert(equivalent(fromDagWire(toDagWire(expr)), expr));
});

Deno.test("dag wire encodes terminals and U8 literals", () => {
  for (const symbol of Object.values(SKITerminalSymbol)) {
    assert(DAG_TERMINAL_CHARS.has(symbol));
    assertEquals(dagCharToSym(symbol), symbol);
    assertEquals(toDagWire(term(symbol)), symbol);
  }

  const compactByte = fromDagWire("U41");
  assertEquals(compactByte.kind, "u8");
  if (compactByte.kind !== "u8") {
    throw new Error("expected compact byte literal");
  }
  assertEquals(compactByte.value, 0x41);

  const sourceByte = fromDagWire("#u8(65)");
  assertEquals(sourceByte.kind, "u8");
  if (sourceByte.kind !== "u8") {
    throw new Error("expected source byte literal");
  }
  assertEquals(sourceByte.value, 65);
  assertEquals(toDagWire(sourceByte), "U41");
});

Deno.test("dag wire rejects malformed tokens", () => {
  assertThrows(() => fromDagWire(""), Error, "empty DAG");
  assertThrows(() => fromDagWire("#u8(256)"), Error, "invalid U8");
  assertThrows(() => fromDagWire("UXY"), Error, "invalid U8");
  assertThrows(() => fromDagWire("@0"), Error, "invalid app");
  assertThrows(() => fromDagWire("@0,0"), Error, "invalid app indices");
  assertThrows(() => fromDagWire("X"), Error, "invalid DAG token");
  assertThrows(() => dagCharToSym("?"), Error, "invalid DAG terminal: ?");
});
