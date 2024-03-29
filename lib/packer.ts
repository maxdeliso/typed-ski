import { Expression } from './expression'
import { nt } from './nonterminal'
import { term, TerminalSymbol } from './terminal'

export type SymbolHeap = Array<TerminalSymbol | undefined>;

export type BinaryHeap = Uint8Array

const rootIndex = 0

function lftIndex (heapIdx: number): number {
  return 2 * heapIdx + 1
}

function rgtIndex (heapIdx: number): number {
  return 2 * heapIdx + 2
}

/**
 * Transform an expression into a symbol heap.
 *
 * @param exp an expression.
 * @returns a symbol heap.
 */
export function heapify (exp: Expression): SymbolHeap {
  const heapLength = maxHeapIndex(exp) + 1
  const result = new Array<TerminalSymbol | undefined>(heapLength)
  const indexes = [rootIndex]
  const nodes = [exp]

  while (indexes.length > 0) {
    const idx = indexes.pop()
    const node = nodes.pop()

    if (idx === undefined || node === undefined) {
      throw new Error('stack elements must be defined')
    } else if (node.kind === 'non-terminal') {
      indexes.push(lftIndex(idx))
      nodes.push(node.lft)

      indexes.push(rgtIndex(idx))
      nodes.push(node.rgt)
    } else if (node.kind === 'terminal') {
      result[idx] = node.sym
    } else {
      throw new Error('unexpected node kind')
    }
  }

  return result
}

export function maxHeapIndex (exp: Expression): number {
  return maxHeapIndexInternal(exp, 0)
}

function maxHeapIndexInternal (exp: Expression, acc: number): number {
  if (exp.kind === 'non-terminal') {
    return Math.max(
      maxHeapIndexInternal(exp.lft, lftIndex(acc)),
      maxHeapIndexInternal(exp.rgt, rgtIndex(acc))
    )
  } else {
    return acc
  }
}

export function unheapify (heapSyms: SymbolHeap): Expression {
  if (heapSyms.length === 0) {
    throw new Error('expression must be non-empty')
  }

  return unheapifyFrom(heapSyms, 0)
}

function unheapifyFrom (heapSyms: SymbolHeap, heapIdx: number): Expression {
  if (heapIdx >= heapSyms.length) {
    throw new Error(`heap index exceeded: ${heapIdx}. input is corrupt.`)
  }

  const heapValue = heapSyms[heapIdx]

  if (heapValue) {
    return term(heapValue)
  } else {
    return nt(
      unheapifyFrom(heapSyms, lftIndex(heapIdx)),
      unheapifyFrom(heapSyms, rgtIndex(heapIdx))
    )
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
function packSymbol (sym: TerminalSymbol | undefined): number {
  if (sym === undefined) {
    return 0b00
  } else if (sym === TerminalSymbol.S) {
    return 0b01
  } else if (sym === TerminalSymbol.K) {
    return 0b10
  } else if (sym === TerminalSymbol.I) {
    return 0b11
  } else {
    throw new Error('Impossible.')
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
function unpackSymbol (n: number): TerminalSymbol | undefined {
  if (n === 0b00) {
    return undefined
  } else if (n === 0b01) {
    return TerminalSymbol.S
  } else if (n === 0b10) {
    return TerminalSymbol.K
  } else if (n === 0b11) {
    return TerminalSymbol.I
  } else {
    throw new Error(`The number ${n} does not correspond to a symbol in SKI.`)
  }
}

/**
 * Pack a symbol heap into a binary heap.
 * @param ts the symbol heap.
 * @returns the binary heap.
 */
export function packSymbolHeap (ts: SymbolHeap): BinaryHeap {
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
  const lenDivFour : number = ts.length / 4 >> 0
  const lenModFourOdd : boolean = ts.length % 4 !== 0
  const packedLength : number = lenDivFour + (lenModFourOdd ? 1 : 0)
  const result = new Uint8Array(packedLength) // note: initialized to zero

  for (let i = 0; i < ts.length; i++) {
    const maybeValue = ts[i]
    const symBits = packSymbol(maybeValue)
    const block = (i / 4) >> 0 // prevents a floating point index
    const shift = (3 - (i % 4)) * 2

    result[block] |= (symBits << shift)
  }

  return result
}

/**
 * Unpack a binary heap into a symbol heap.
 * This is to reduce the in memory size of the symbol heap.
 * @param inputBytes a sequence of bytes that contains an encoded symbol heap.
 * @returns the corresponding symbol heap.
 */
export function unpackBinaryHeap (inputBytes: BinaryHeap): SymbolHeap {
  const result: SymbolHeap = []

  for (let i = 0; i < inputBytes.length; i++) {
    const byte = inputBytes[i] || 0

    /*
     * 0 b 1100 0000 = 0 x C 0
     * 0 b 0011 0000 = 0 x 3 0
     * 0 b 0000 1100 = 0 x 0 C
     * 0 b 0000 0011 = 0 x 0 3
     */
    const fourSnakeEyes = [
      (byte & 0xC0) >> 6,
      (byte & 0x30) >> 4,
      (byte & 0x0C) >> 2,
      (byte & 0x03) >> 0
    ]

    fourSnakeEyes
      .map(unpackSymbol)
      .forEach(maybeSym => result.push(maybeSym))
  }

  return result
}

/**
 * Pack an expression into a contiguous sequence of heap ordered bits.
 * @param exp the input expression.
 * @returns a binary heap packed result.
 */
export function packHeap (exp: Expression): BinaryHeap {
  return packSymbolHeap(heapify(exp))
}

/**
 * Re-inflate a sequence of packed heap ordered bits into an Expression.
 * @param heapBytes the input binary heap.
 * @returns an expression.
 */
export function unpackHeap (heapBytes: BinaryHeap): Expression {
  return unheapify(unpackBinaryHeap(heapBytes))
}
