import type { SKIExpression } from "./expression.ts";
import { apply } from "./expression.ts";
import { SKITerminalSymbol, term } from "./terminal.ts";

const TOPO_DAG_WIRE_TERMINAL_SYMBOLS = [
  SKITerminalSymbol.S,
  SKITerminalSymbol.K,
  SKITerminalSymbol.I,
  SKITerminalSymbol.B,
  SKITerminalSymbol.C,
  SKITerminalSymbol.SPrime,
  SKITerminalSymbol.BPrime,
  SKITerminalSymbol.CPrime,
  SKITerminalSymbol.ReadOne,
  SKITerminalSymbol.WriteOne,
  SKITerminalSymbol.EqU8,
  SKITerminalSymbol.LtU8,
  SKITerminalSymbol.DivU8,
  SKITerminalSymbol.ModU8,
  SKITerminalSymbol.AddU8,
  SKITerminalSymbol.SubU8,
] as const;

export const TOPO_DAG_WIRE_TERMINAL_CHARS: Set<string> = new Set<string>(
  TOPO_DAG_WIRE_TERMINAL_SYMBOLS,
);

export const TOPO_DAG_WIRE_POINTER_HEX_WIDTH = 8;
export const TOPO_DAG_WIRE_TERM_WIDTH = 3;
export const TOPO_DAG_WIRE_RECORD_WIDTH =
  TOPO_DAG_WIRE_TERM_WIDTH + TOPO_DAG_WIRE_POINTER_HEX_WIDTH * 2;
export const TOPO_DAG_WIRE_SEPARATOR = "|";
export const TOPO_DAG_WIRE_STRIDE = TOPO_DAG_WIRE_RECORD_WIDTH + 1;
export const TOPO_DAG_WIRE_NULL_POINTER = "F".repeat(
  TOPO_DAG_WIRE_POINTER_HEX_WIDTH,
);

const APP_FIELD = "@00";
const DEFAULT_RECORDS_PER_CHUNK = 2048;
const HEX_BYTE_TABLE = Array.from(
  { length: 256 },
  (_, byte) => byte.toString(16).toUpperCase().padStart(2, "0"),
);

export interface TopoDagWireEncodeOptions {
  recordsPerChunk?: number;
}

export interface TopoDagWireWriteResult {
  recordCount: number;
  charLength: number;
}

export interface TopoDagWireRecordSlice {
  index: number;
  offset: number;
  record: string;
}

export type TopoDagWireChunkSink = (chunk: string) => void;
export type AsyncTopoDagWireChunkSink = (
  chunk: string,
) => void | Promise<void>;

function encodePointer(offset: number | null): string {
  if (offset === null) {
    return TOPO_DAG_WIRE_NULL_POINTER;
  }
  if (!Number.isInteger(offset) || offset < 0 || offset > 0xffffffff) {
    throw new Error("pointer out of range: " + offset);
  }
  return encodePointerUnchecked(offset);
}

function encodePointerUnchecked(offset: number): string {
  return (
    HEX_BYTE_TABLE[(offset >>> 24) & 0xff]! +
    HEX_BYTE_TABLE[(offset >>> 16) & 0xff]! +
    HEX_BYTE_TABLE[(offset >>> 8) & 0xff]! +
    HEX_BYTE_TABLE[offset & 0xff]!
  );
}

function decodeHexNibble(charCode: number): number {
  if (charCode >= 0x30 && charCode <= 0x39) {
    return charCode - 0x30;
  }
  if (charCode >= 0x41 && charCode <= 0x46) {
    return charCode - 0x41 + 10;
  }
  if (charCode >= 0x61 && charCode <= 0x66) {
    return charCode - 0x61 + 10;
  }
  return -1;
}

function decodeHexByte(field: string, offset: number): number {
  const high = decodeHexNibble(field.charCodeAt(offset));
  const low = decodeHexNibble(field.charCodeAt(offset + 1));
  if (high < 0 || low < 0) {
    throw new Error("invalid topoDagWire hex field: " + field);
  }
  return (high << 4) | low;
}

function decodePointer(field: string): number | null {
  if (field === TOPO_DAG_WIRE_NULL_POINTER) {
    return null;
  }
  if (field.length !== TOPO_DAG_WIRE_POINTER_HEX_WIDTH) {
    throw new Error("invalid topoDagWire pointer width: " + field);
  }
  const pointer =
    (((decodeHexByte(field, 0) * 256 + decodeHexByte(field, 2)) * 256 +
      decodeHexByte(field, 4)) *
      256 +
      decodeHexByte(field, 6)) >>>
    0;
  return pointer;
}

function encodeTermField(node: SKIExpression): string {
  if (node.kind === "terminal") {
    return node.sym + "00";
  }
  if (node.kind === "u8") {
    return "U" + HEX_BYTE_TABLE[node.value];
  }
  return APP_FIELD;
}

function decodeRecordTerm(termField: string): {
  kind: "terminal" | "u8" | "app";
  value?: SKITerminalSymbol | number;
} {
  if (termField === APP_FIELD) {
    return { kind: "app" };
  }
  if (termField.startsWith("U")) {
    const byte = Number.parseInt(termField.slice(1), 16);
    if (!Number.isInteger(byte) || byte < 0 || byte > 0xff) {
      throw new Error("invalid topoDagWire U8 term: " + termField);
    }
    return { kind: "u8", value: byte };
  }
  const symbol = termField.charAt(0);
  if (
    termField.slice(1) !== "00" ||
    !TOPO_DAG_WIRE_TERMINAL_CHARS.has(symbol)
  ) {
    throw new Error("invalid topoDagWire terminal: " + termField);
  }
  return { kind: "terminal", value: topoDagWireCharToSym(symbol) };
}

function validateLeafPointers(
  leftPointer: number | null,
  rightPointer: number | null,
  termField: string,
): void {
  if (leftPointer !== null || rightPointer !== null) {
    throw new Error(
      "leaf topoDagWire node must use null pointers: " + termField,
    );
  }
}

function validateChildPointer(
  pointer: number | null,
  currentOffset: number,
  fieldName: string,
): number {
  if (pointer === null) {
    throw new Error(`application topoDagWire record is missing ${fieldName}`);
  }
  if (pointer % TOPO_DAG_WIRE_STRIDE !== 0) {
    throw new Error(
      `application topoDagWire ${fieldName} is not record-aligned: ${pointer}`,
    );
  }
  if (pointer >= currentOffset) {
    throw new Error(
      `application topoDagWire ${fieldName} must point backward: ${pointer}`,
    );
  }
  return pointer / TOPO_DAG_WIRE_STRIDE;
}

function normalizeChunkRecordCount(
  recordsPerChunk: number | undefined,
): number {
  if (recordsPerChunk === undefined) {
    return DEFAULT_RECORDS_PER_CHUNK;
  }
  if (!Number.isInteger(recordsPerChunk) || recordsPerChunk <= 0) {
    throw new Error("recordsPerChunk must be a positive integer");
  }
  return recordsPerChunk;
}

function trimmedTopoDagWireOrThrow(topoDagWire: string): string {
  const trimmed = topoDagWire.trim();
  if (trimmed.length === 0) {
    throw new Error("empty topoDagWire");
  }
  return trimmed;
}

function topoDagWireMetadataOrThrow(topoDagWire: string): {
  trimmed: string;
  recordCount: number;
} {
  const trimmed = trimmedTopoDagWireOrThrow(topoDagWire);
  return {
    trimmed,
    recordCount: validateTrimmedTopoDagWireLength(trimmed),
  };
}

function validateTrimmedTopoDagWireLength(trimmed: string): number {
  if (
    (trimmed.length + TOPO_DAG_WIRE_SEPARATOR.length) % TOPO_DAG_WIRE_STRIDE !==
    0
  ) {
    throw new Error("invalid topoDagWire record width");
  }
  return (
    (trimmed.length + TOPO_DAG_WIRE_SEPARATOR.length) / TOPO_DAG_WIRE_STRIDE
  );
}

function collectTopoDagOrder(root: SKIExpression): SKIExpression[] {
  const order: SKIExpression[] = [];
  const expanded = new Set<SKIExpression>();
  const emitted = new Set<SKIExpression>();
  const stack: SKIExpression[] = [root];

  while (stack.length > 0) {
    const node = stack[stack.length - 1]!;
    if (emitted.has(node)) {
      stack.pop();
      continue;
    }

    if (node.kind !== "non-terminal") {
      emitted.add(node);
      order.push(node);
      stack.pop();
      continue;
    }

    if (expanded.has(node)) {
      emitted.add(node);
      order.push(node);
      stack.pop();
      continue;
    }

    expanded.add(node);
    if (!emitted.has(node.rgt)) {
      stack.push(node.rgt);
    }
    if (!emitted.has(node.lft)) {
      stack.push(node.lft);
    }
  }

  return order;
}

function buildTopoDagRecord(
  node: SKIExpression,
  nodeToOffset: ReadonlyMap<SKIExpression, number>,
): string {
  const termField = encodeTermField(node);
  const leftPointer =
    node.kind === "non-terminal" ? nodeToOffset.get(node.lft)! : null;
  const rightPointer =
    node.kind === "non-terminal" ? nodeToOffset.get(node.rgt)! : null;
  return (
    termField + encodePointer(leftPointer) + encodePointer(rightPointer)
  );
}

function shiftPointerField(field: string, offset: number): string {
  const pointer = decodePointer(field);
  if (pointer === null) {
    return field;
  }
  return encodePointer(pointer + offset);
}

function shiftTopoDagRecord(record: string, offset: number): string {
  const leftStart = TOPO_DAG_WIRE_TERM_WIDTH;
  const rightStart = leftStart + TOPO_DAG_WIRE_POINTER_HEX_WIDTH;
  const leftField = record.slice(leftStart, rightStart);
  const rightField = record.slice(rightStart, TOPO_DAG_WIRE_RECORD_WIDTH);
  if (
    leftField === TOPO_DAG_WIRE_NULL_POINTER &&
    rightField === TOPO_DAG_WIRE_NULL_POINTER
  ) {
    return record;
  }
  return (
    record.slice(0, TOPO_DAG_WIRE_TERM_WIDTH) +
    shiftPointerField(leftField, offset) +
    shiftPointerField(rightField, offset)
  );
}

function decodeTopoDagRecordInto(
  record: string,
  recordCount: number,
  nodes: SKIExpression[],
): void {
  if (record.length !== TOPO_DAG_WIRE_RECORD_WIDTH) {
    throw new Error("invalid topoDagWire record width");
  }

  const currentOffset = recordCount * TOPO_DAG_WIRE_STRIDE;
  const termField = record.slice(0, TOPO_DAG_WIRE_TERM_WIDTH);
  const leftField = record.slice(
    TOPO_DAG_WIRE_TERM_WIDTH,
    TOPO_DAG_WIRE_TERM_WIDTH + TOPO_DAG_WIRE_POINTER_HEX_WIDTH,
  );
  const rightField = record.slice(
    TOPO_DAG_WIRE_TERM_WIDTH + TOPO_DAG_WIRE_POINTER_HEX_WIDTH,
  );
  const leftPointer = decodePointer(leftField);
  const rightPointer = decodePointer(rightField);
  const termValue = decodeRecordTerm(termField);

  if (termValue.kind === "terminal") {
    validateLeafPointers(leftPointer, rightPointer, termField);
    nodes.push(term(termValue.value as SKITerminalSymbol));
    return;
  }

  if (termValue.kind === "u8") {
    validateLeafPointers(leftPointer, rightPointer, termField);
    nodes.push({ kind: "u8", value: termValue.value as number });
    return;
  }

  const leftIndex = validateChildPointer(leftPointer, currentOffset, "left");
  const rightIndex = validateChildPointer(rightPointer, currentOffset, "right");
  nodes.push(apply(nodes[leftIndex]!, nodes[rightIndex]!));
}

/**
 * Topo DAG wire format:
 * - fixed-width records
 * - children emitted before parents
 * - each record is `term(3) left(8) right(8)`
 * - records are `|` separated
 * - left/right are hex byte offsets into the serialized string
 */
export function writeTopoDagWire(
  expr: SKIExpression,
  sink: TopoDagWireChunkSink,
  options: TopoDagWireEncodeOptions = {},
): TopoDagWireWriteResult {
  const order = collectTopoDagOrder(expr);
  const nodeToOffset = new Map<SKIExpression, number>();
  const chunkParts: string[] = [];
  let charLength = 0;
  let recordsInChunk = 0;
  let isFirstRecord = true;
  const recordsPerChunk = normalizeChunkRecordCount(options.recordsPerChunk);

  for (let index = 0; index < order.length; index++) {
    const node = order[index]!;
    nodeToOffset.set(node, index * TOPO_DAG_WIRE_STRIDE);
  }

  for (const node of order) {
    if (!isFirstRecord) {
      chunkParts.push(TOPO_DAG_WIRE_SEPARATOR);
    }
    chunkParts.push(buildTopoDagRecord(node, nodeToOffset));
    isFirstRecord = false;
    recordsInChunk++;

    if (recordsInChunk >= recordsPerChunk) {
      const chunk = chunkParts.join("");
      sink(chunk);
      charLength += chunk.length;
      chunkParts.length = 0;
      recordsInChunk = 0;
    }
  }

  if (chunkParts.length > 0) {
    const chunk = chunkParts.join("");
    sink(chunk);
    charLength += chunk.length;
  }

  return { recordCount: order.length, charLength };
}

export async function writeTopoDagWireAsync(
  expr: SKIExpression,
  sink: AsyncTopoDagWireChunkSink,
  options: TopoDagWireEncodeOptions = {},
): Promise<TopoDagWireWriteResult> {
  const order = collectTopoDagOrder(expr);
  const nodeToOffset = new Map<SKIExpression, number>();
  const chunkParts: string[] = [];
  let charLength = 0;
  let recordsInChunk = 0;
  let isFirstRecord = true;
  const recordsPerChunk = normalizeChunkRecordCount(options.recordsPerChunk);

  for (let index = 0; index < order.length; index++) {
    const node = order[index]!;
    nodeToOffset.set(node, index * TOPO_DAG_WIRE_STRIDE);
  }

  for (const node of order) {
    if (!isFirstRecord) {
      chunkParts.push(TOPO_DAG_WIRE_SEPARATOR);
    }
    chunkParts.push(buildTopoDagRecord(node, nodeToOffset));
    isFirstRecord = false;
    recordsInChunk++;

    if (recordsInChunk >= recordsPerChunk) {
      const chunk = chunkParts.join("");
      await sink(chunk);
      charLength += chunk.length;
      chunkParts.length = 0;
      recordsInChunk = 0;
    }
  }

  if (chunkParts.length > 0) {
    const chunk = chunkParts.join("");
    await sink(chunk);
    charLength += chunk.length;
  }

  return { recordCount: order.length, charLength };
}

export function toTopoDagWireChunks(
  expr: SKIExpression,
  options: TopoDagWireEncodeOptions = {},
): string[] {
  const chunks: string[] = [];
  writeTopoDagWire(
    expr,
    (chunk) => {
      chunks.push(chunk);
    },
    options,
  );
  return chunks;
}

export function toTopoDagWire(
  expr: SKIExpression,
  options: TopoDagWireEncodeOptions = {},
): string {
  return toTopoDagWireChunks(expr, options).join("");
}

export function combineTopoDagWires(leftDag: string, rightDag: string): string {
  const left = topoDagWireMetadataOrThrow(leftDag);
  const right = topoDagWireMetadataOrThrow(rightDag);
  const translatedRight: string[] = [];
  const rightOffset = left.trimmed.length + TOPO_DAG_WIRE_SEPARATOR.length;

  for (let index = 0; index < right.recordCount; index++) {
    const start = index * TOPO_DAG_WIRE_STRIDE;
    const record = right.trimmed.slice(start, start + TOPO_DAG_WIRE_RECORD_WIDTH);
    if (index > 0) {
      translatedRight.push(TOPO_DAG_WIRE_SEPARATOR);
    }
    translatedRight.push(shiftTopoDagRecord(record, rightOffset));
  }

  const root1 = encodePointerUnchecked(
    (left.recordCount - 1) * TOPO_DAG_WIRE_STRIDE,
  );
  const root2 = encodePointerUnchecked(
    rightOffset + (right.recordCount - 1) * TOPO_DAG_WIRE_STRIDE,
  );

  return (
    left.trimmed +
    TOPO_DAG_WIRE_SEPARATOR +
    translatedRight.join("") +
    TOPO_DAG_WIRE_SEPARATOR +
    APP_FIELD +
    root1 +
    root2
  );
}

export function topoDagWireCharToSym(char: string): SKITerminalSymbol {
  const symbol = char as SKITerminalSymbol;
  if (!TOPO_DAG_WIRE_TERMINAL_CHARS.has(char)) {
    throw new Error("invalid topoDagWire terminal: " + char);
  }
  return symbol;
}

export function countTopoDagWireRecords(topoDagWire: string): number {
  const trimmed = topoDagWire.trim();
  if (trimmed.length === 0) {
    return 0;
  }
  return validateTrimmedTopoDagWireLength(trimmed);
}

export function* iterateTopoDagWireRecords(
  topoDagWire: string,
): Generator<TopoDagWireRecordSlice> {
  const { trimmed, recordCount } = topoDagWireMetadataOrThrow(topoDagWire);

  for (let index = 0; index < recordCount; index++) {
    const start = index * TOPO_DAG_WIRE_STRIDE;
    const end = start + TOPO_DAG_WIRE_RECORD_WIDTH;
    if (index + 1 < recordCount && trimmed.charAt(end) !== TOPO_DAG_WIRE_SEPARATOR) {
      throw new Error("invalid topoDagWire separator");
    }
    yield {
      index,
      offset: start,
      record: trimmed.slice(start, end),
    };
  }
}

export class TopoDagWireDecoder {
  private pending = "";
  private recordCount = 0;
  private readonly nodes: SKIExpression[] = [];

  write(chunk: string): void {
    if (chunk.length === 0) {
      return;
    }
    this.pending += chunk;

    while (true) {
      const separatorIndex = this.pending.indexOf(TOPO_DAG_WIRE_SEPARATOR);
      if (separatorIndex < 0) {
        return;
      }
      this.consumeRecord(this.pending.slice(0, separatorIndex));
      this.pending = this.pending.slice(separatorIndex + 1);
    }
  }

  finish(): SKIExpression {
    if (this.pending.length === 0 && this.recordCount === 0) {
      throw new Error("empty topoDagWire");
    }
    this.consumeRecord(this.pending);
    this.pending = "";

    const root = this.nodes[this.nodes.length - 1];
    if (!root) {
      throw new Error("empty topoDagWire");
    }
    return root;
  }
  private consumeRecord(record: string): void {
    decodeTopoDagRecordInto(record, this.recordCount, this.nodes);
    this.recordCount++;
  }
}

export function createTopoDagWireDecoder(): TopoDagWireDecoder {
  return new TopoDagWireDecoder();
}

export function fromTopoDagWire(topoDagWire: string): SKIExpression {
  const decoder = new TopoDagWireDecoder();
  decoder.write(trimmedTopoDagWireOrThrow(topoDagWire));
  return decoder.finish();
}
