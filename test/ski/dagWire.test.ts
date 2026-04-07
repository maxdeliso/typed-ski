import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TOPO_DAG_WIRE_NULL_POINTER,
  TOPO_DAG_WIRE_TERMINAL_CHARS,
  TopoDagWireDecoder,
  combineTopoDagWires,
  countTopoDagWireRecords,
  topoDagWireCharToSym,
  fromTopoDagWire,
  iterateTopoDagWireRecords,
  toTopoDagWire,
  toTopoDagWireChunks,
  writeTopoDagWire,
  writeTopoDagWireAsync,
} from "../../lib/ski/topoDagWire.ts";
import { apply, equivalent } from "../../lib/ski/expression.ts";
import { K, S, SKITerminalSymbol, term } from "../../lib/ski/terminal.ts";

function encodePointer(offset: number): string {
  return offset.toString(16).toUpperCase().padStart(8, "0");
}

function terminalRecord(symbol: string): string {
  return `${symbol}00${TOPO_DAG_WIRE_NULL_POINTER}${TOPO_DAG_WIRE_NULL_POINTER}`;
}

function u8Record(value: number): string {
  return `U${value.toString(16).toUpperCase().padStart(2, "0")}${TOPO_DAG_WIRE_NULL_POINTER}${TOPO_DAG_WIRE_NULL_POINTER}`;
}

function appRecord(left: number, right: number): string {
  return `@00${encodePointer(left)}${encodePointer(right)}`;
}

test("topoDagWire round-trips shared application graphs", () => {
  const shared = apply(S, K);
  const expr = apply(shared, shared);

  assert.deepStrictEqual(
    toTopoDagWire(expr),
    [
      terminalRecord("S"),
      terminalRecord("K"),
      appRecord(0, 20),
      appRecord(40, 40),
    ].join("|"),
  );
  assert.ok(equivalent(fromTopoDagWire(toTopoDagWire(expr)), expr));
});

test("topoDagWire encodes terminals and U8 literals", () => {
  for (const symbol of Object.values(SKITerminalSymbol)) {
    assert.ok(TOPO_DAG_WIRE_TERMINAL_CHARS.has(symbol));
    assert.deepStrictEqual(topoDagWireCharToSym(symbol), symbol);
    assert.deepStrictEqual(toTopoDagWire(term(symbol)), terminalRecord(symbol));
  }

  const compactByte = fromTopoDagWire(u8Record(0x41));
  assert.deepStrictEqual(compactByte.kind, "u8");
  if (compactByte.kind !== "u8") {
    throw new Error("expected compact byte literal");
  }
  assert.deepStrictEqual(compactByte.value, 0x41);

  const sourceByte = fromTopoDagWire(u8Record(65));
  assert.deepStrictEqual(sourceByte.kind, "u8");
  if (sourceByte.kind !== "u8") {
    throw new Error("expected source byte literal");
  }
  assert.deepStrictEqual(sourceByte.value, 65);
  assert.deepStrictEqual(toTopoDagWire(sourceByte), u8Record(0x41));
});

test("topoDagWire streams fixed-width chunks and decodes incrementally", () => {
  const shared = apply(S, K);
  const expr = apply(shared, shared);
  const expected = [
    terminalRecord("S"),
    terminalRecord("K"),
    appRecord(0, 20),
    appRecord(40, 40),
  ].join("|");

  const streamedChunks: string[] = [];
  const writeResult = writeTopoDagWire(
    expr,
    (chunk) => {
      streamedChunks.push(chunk);
    },
    { recordsPerChunk: 2 },
  );

  assert.deepStrictEqual(streamedChunks, [
    [terminalRecord("S"), terminalRecord("K")].join("|"),
    "|" + [appRecord(0, 20), appRecord(40, 40)].join("|"),
  ]);
  assert.deepStrictEqual(writeResult.recordCount, 4);
  assert.deepStrictEqual(writeResult.charLength, expected.length);
  assert.deepStrictEqual(toTopoDagWireChunks(expr, { recordsPerChunk: 2 }), streamedChunks);
  assert.deepStrictEqual(streamedChunks.join(""), expected);
  assert.deepStrictEqual(countTopoDagWireRecords(expected), 4);
  assert.deepStrictEqual(
    Array.from(iterateTopoDagWireRecords(expected)).map(({ record }) => record),
    expected.split("|"),
  );

  const decoder = new TopoDagWireDecoder();
  for (const chunk of streamedChunks) {
    decoder.write(chunk);
  }
  assert.ok(equivalent(decoder.finish(), expr));
});

test("topoDagWire async writer and DAG combiner preserve sharing layout", async () => {
  const shared = apply(S, K);
  const left = apply(shared, shared);
  const right = apply(K, S);
  const leftDag = toTopoDagWire(left);
  const rightDag = toTopoDagWire(right);
  const asyncChunks: string[] = [];

  const writeResult = await writeTopoDagWireAsync(
    left,
    async (chunk) => {
      asyncChunks.push(chunk);
    },
    { recordsPerChunk: 2 },
  );

  assert.deepStrictEqual(asyncChunks.join(""), leftDag);
  assert.deepStrictEqual(writeResult.charLength, leftDag.length);
  assert.deepStrictEqual(writeResult.recordCount, 4);

  const combined = combineTopoDagWires(leftDag, rightDag);
  assert.ok(
    equivalent(fromTopoDagWire(combined), apply(left, right)),
    "combined topoDagWire should decode to the original application",
  );
});

test("topoDagWire rejects malformed records", () => {
  assert.throws(() => fromTopoDagWire(""), Error, "empty topoDagWire");
  assert.throws(() => fromTopoDagWire("U41"), Error, "invalid record width");
  assert.throws(
    () => fromTopoDagWire(`@00ZZZZZZZZ00000000`),
    Error,
    "invalid pointer field",
  );
  assert.throws(
    () => fromTopoDagWire(appRecord(0, 0)),
    Error,
    "application cannot point to itself",
  );
  assert.throws(
    () =>
      fromTopoDagWire(
        `?00${TOPO_DAG_WIRE_NULL_POINTER}${TOPO_DAG_WIRE_NULL_POINTER}`,
      ),
    Error,
    "invalid terminal",
  );
  assert.throws(
    () => topoDagWireCharToSym("?"),
    Error,
    "invalid topoDagWire terminal",
  );
});
