/**
 * SKI expression packing and heap representation.
 *
 * This module provides functionality for converting SKI expressions to and from
 * compact heap-based representations, including binary packing for efficient storage.
 *
 * @module
 */
import { cons } from "../cons.ts";
import type { SKIExpression } from "./expression.ts";
import { SKITerminalSymbol, term } from "./terminal.ts";

export type SymbolHeap = (SKITerminalSymbol | undefined)[];

export type BinaryHeap = Uint8Array;

const rootIndex = 0;

function lftIndex(heapIdx: number): number {
  return 2 * heapIdx + 1;
}

function rgtIndex(heapIdx: number): number {
  return 2 * heapIdx + 2;
}

/**
 * Transform an expression into a symbol heap.
 *
 * @param exp an expression.
 * @returns a symbol heap.
 */
export function heapify(exp: SKIExpression): SymbolHeap {
  const heapLength = maxHeapIndex(exp) + 1;
  const result = new Array<SKITerminalSymbol | undefined>(heapLength).fill(
    undefined,
  );
  const indexes = [rootIndex];
  const nodes = [exp];

  while (indexes.length > 0) {
    const idx = indexes.pop();
    const node = nodes.pop();

    if (idx === undefined || node === undefined) {
      throw new Error("stack elements must be defined");
    } else if (node.kind === "non-terminal") {
      indexes.push(lftIndex(idx));
      nodes.push(node.lft);

      indexes.push(rgtIndex(idx));
      nodes.push(node.rgt);
    } else {
      result[idx] = node.sym;
    }
  }

  return result;
}

export function maxHeapIndex(exp: SKIExpression): number {
  return maxHeapIndexInternal(exp, 0);
}

function maxHeapIndexInternal(exp: SKIExpression, acc: number): number {
  if (exp.kind === "non-terminal") {
    return Math.max(
      maxHeapIndexInternal(exp.lft, lftIndex(acc)),
      maxHeapIndexInternal(exp.rgt, rgtIndex(acc)),
    );
  } else {
    return acc;
  }
}

export function unheapify(heapSyms: SymbolHeap): SKIExpression {
  if (heapSyms.length === 0) {
    throw new Error("expression must be non-empty");
  }

  return unheapifyFrom(heapSyms, 0);
}

function unheapifyFrom(heapSyms: SymbolHeap, heapIdx: number): SKIExpression {
  if (heapIdx >= heapSyms.length) {
    throw new Error(
      `heap index exceeded: ${heapIdx.toString()}. input is corrupt.`,
    );
  }

  const heapValue = heapSyms[heapIdx];

  if (heapValue) {
    return term(heapValue);
  } else {
    return cons(
      unheapifyFrom(heapSyms, lftIndex(heapIdx)),
      unheapifyFrom(heapSyms, rgtIndex(heapIdx)),
    );
  }
}

/**
 * ∅ -> b00
 * S -> b01
 * K -> b10
 * I -> b11
 *
 * @see unpackSymbol
 * @throws this was tossed in here to make the type of this function number
 *
 * NOTE: here ∅ represents the empty set, or lack of a value.
 */
function packSymbol(sym: SKITerminalSymbol | undefined): number {
  if (sym === undefined) {
    return 0b00;
  } else if (sym === SKITerminalSymbol.S) {
    return 0b01;
  } else if (sym === SKITerminalSymbol.K) {
    return 0b10;
  } else {
    return 0b11;
  }
}

/**
 * b00 -> ∅
 * b01 -> S
 * b10 -> K
 * b11 -> I
 *
 * @see packSymbol
 */
function unpackSymbol(n: number): SKITerminalSymbol | undefined {
  if (n === 0b00) {
    return undefined;
  } else if (n === 0b01) {
    return SKITerminalSymbol.S;
  } else if (n === 0b10) {
    return SKITerminalSymbol.K;
  } else if (n === 0b11) {
    return SKITerminalSymbol.I;
  } else {
    throw new Error(
      `The number ${n.toString()} does not correspond to a symbol in SKI.`,
    );
  }
}

/**
 * Pack a symbol heap into a binary heap.
 * @param ts the symbol heap.
 * @returns the binary heap.
 */
export function packSymbolHeap(ts: SymbolHeap): BinaryHeap {
  /*
   * ts byteCount /4 %4 /4+1 %4!=0
   * 0  0         0  0  1    0
   * 1  1         0  1  1    1
   * 2  1         0  2  1    1
   * 3  1         0  3  1    1
   * 4  1         1  0  2    0
   * 5  2         1  1  2    1
   * 6  2         1  2  2    1
   * 7  2         1  3  2    1
   * 8  2         2  0  2    0
   * 9  3         2  1  3    1
   */
  const lenDivFour: number = ts.length / 4 >> 0;
  const lenModFourOdd: boolean = ts.length % 4 !== 0;
  const packedLength: number = lenDivFour + (lenModFourOdd ? 1 : 0);
  const result = new Uint8Array(packedLength); // note: initialized to zero

  for (let i = 0; i < ts.length; i++) {
    const maybeValue = ts[i];
    const symBits = packSymbol(maybeValue);
    const block = (i / 4) >> 0; // prevents a floating point index
    const shift = (3 - (i % 4)) * 2;

    result[block] |= symBits << shift;
  }

  return result;
}

/**
 * Unpack a binary heap into a symbol heap.
 * This is to reduce the in memory size of the symbol heap.
 * @param inputBytes a sequence of bytes that contains an encoded symbol heap.
 * @returns the corresponding symbol heap.
 */
export function unpackBinaryHeap(inputBytes: BinaryHeap): SymbolHeap {
  const result: SymbolHeap = [];

  for (const by of inputBytes) {
    /*
     * 0 b 1100 0000 = 0 x C 0
     * 0 b 0011 0000 = 0 x 3 0
     * 0 b 0000 1100 = 0 x 0 C
     * 0 b 0000 0011 = 0 x 0 3
     */
    const fourSnakeEyes = [
      (by & 0xC0) >> 6,
      (by & 0x30) >> 4,
      (by & 0x0C) >> 2,
      (by & 0x03) >> 0,
    ];

    fourSnakeEyes
      .map(unpackSymbol)
      .forEach((maybeSym) => result.push(maybeSym));
  }

  return result;
}

/**
 * Pack an expression into a contiguous sequence of heap ordered bits.
 * @param exp the input expression.
 * @returns a binary heap packed result.
 */
export function packHeap(exp: SKIExpression): BinaryHeap {
  return packSymbolHeap(heapify(exp));
}

/**
 * Re-inflate a sequence of packed heap ordered bits into an Expression.
 * @param heapBytes the input binary heap.
 * @returns an expression.
 */
export function unpackHeap(heapBytes: BinaryHeap): SKIExpression {
  return unheapify(unpackBinaryHeap(heapBytes));
}
