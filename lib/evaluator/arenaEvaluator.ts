/**
 * WebAssembly-based arena evaluator for SKI expressions.
 *
 * This module provides a WebAssembly-based evaluator for SKI expressions
 * using arena-based memory management for efficient evaluation.
 *
 * @module
 */

import type { SKIExpression } from "../ski/expression.ts";
import { apply } from "../ski/expression.ts";
import { I, K, S, SKITerminalSymbol } from "../ski/terminal.ts";
import type { Evaluator } from "./evaluator.ts";
import { ArenaKind, type ArenaNodeId, ArenaSym } from "../shared/arena.ts";
import type { ArenaNode } from "../shared/types.ts";
import { getEmbeddedReleaseWasm } from "./arenaWasm.embedded.ts";

/**
 * Terminal cache: Maps exports instance -> {S, K, I} IDs
 * This allows each evaluator instance to have its own terminal cache
 */
const terminalCache = new WeakMap<
  Pick<ArenaWasmExports, "allocTerminal">,
  { s: number; k: number; i: number }
>();

/**
 * Convert an SKI expression to an arena node ID.
 * Shared utility function used by both ArenaEvaluatorWasm and arenaWorker.
 *
 * Uses iterative processing with memoization to:
 * 1. Avoid call stack overflow on deep structures
 * 2. Deduplicate shared nodes (DAGs) to prevent unnecessary allocations
 * 3. Cache terminal symbols to avoid repeated WASM calls
 */
export function toArenaWithExports(
  root: SKIExpression,
  exports: Pick<
    ArenaWasmExports,
    "allocTerminal" | "allocCons"
  >,
): ArenaNodeId {
  const EMPTY = 0xffffffff;

  // 1. Initialize terminal cache for this exports instance
  let cache = terminalCache.get(exports);
  if (!cache) {
    cache = {
      s: exports.allocTerminal(ArenaSym.S),
      k: exports.allocTerminal(ArenaSym.K),
      i: exports.allocTerminal(ArenaSym.I),
    };
    terminalCache.set(exports, cache);
  }

  // 2. Memoization Map: SKIExpression (JS Object) -> ArenaNodeId (WASM Int)
  // This dedups shared references (DAGs) on the fly, preventing unnecessary allocations.
  const exprCache = new Map<SKIExpression, number>();

  // 3. Explicit Stack for Iterative Post-Order Traversal
  const stack: SKIExpression[] = [root];

  while (stack.length > 0) {
    // Peek at the top node
    const expr = stack[stack.length - 1];

    if (exprCache.has(expr)) {
      stack.pop();
      continue;
    }

    if (expr.kind === "terminal") {
      let id: number;
      switch (expr.sym) {
        case SKITerminalSymbol.S:
          id = cache.s;
          break;
        case SKITerminalSymbol.K:
          id = cache.k;
          break;
        case SKITerminalSymbol.I:
          id = cache.i;
          break;
        default:
          throw new Error("Unrecognised terminal symbol");
      }
      exprCache.set(expr, id);
      stack.pop();
    } else {
      // Non-Terminal: We need children to be allocated first
      const left = expr.lft;
      const right = expr.rgt;

      const leftId = exprCache.get(left);
      const rightId = exprCache.get(right);

      if (leftId !== undefined && rightId !== undefined) {
        // Both children are ready. Allocate the cons cell.
        const id = exports.allocCons(leftId, rightId);
        if (id === EMPTY) {
          throw new Error("Arena Out of Memory during marshaling");
        }
        exprCache.set(expr, id);
        stack.pop();
      } else {
        // Push children to stack (Right first, so Left is processed first)
        if (rightId === undefined) stack.push(right);
        if (leftId === undefined) stack.push(left);
      }
    }
  }

  return exprCache.get(root)!;
}

/**
 * Convert an arena node ID to an SKI expression.
 * Shared utility function used by both ArenaEvaluatorWasm and arenaWorker.
 *
 * Uses iterative processing with memoization to:
 * 1. Avoid call stack overflow on deep structures
 * 2. Preserve DAG structure (hash consing) to prevent memory explosion
 */
export function fromArenaWithExports(
  rootId: ArenaNodeId,
  exports: Pick<ArenaWasmExports, "kindOf" | "symOf" | "leftOf" | "rightOf">,
): SKIExpression {
  // 1. Memoization Cache: Maps Arena ID -> JS Object
  // This preserves the DAG structure (sharing), preventing memory explosion.
  const cache = new Map<number, SKIExpression>();

  // 2. Explicit Stack: Stores IDs of nodes we need to process.
  // This replaces the call stack, preventing "Maximum call stack size exceeded".
  const stack: number[] = [rootId];

  while (stack.length > 0) {
    // Peek at the current node (don't pop yet, we might need to push children)
    const id = stack[stack.length - 1];

    // If we've already built this node, just pop and move on
    if (cache.has(id)) {
      stack.pop();
      continue;
    }

    const kind = exports.kindOf(id);

    if (kind === (ArenaKind.Terminal as number)) {
      // TERMINAL: Construct immediately and cache
      const sym = exports.symOf(id);
      let expr: SKIExpression;
      switch (sym) {
        case ArenaSym.S:
          expr = S;
          break;
        case ArenaSym.K:
          expr = K;
          break;
        case ArenaSym.I:
          expr = I;
          break;
        default:
          throw new Error(`Unknown symbol tag: ${sym}`);
      }
      cache.set(id, expr);
      stack.pop();
    } else {
      // NON-TERMINAL: Check children
      const leftId = exports.leftOf(id);
      const rightId = exports.rightOf(id);

      const leftDone = cache.has(leftId);
      const rightDone = cache.has(rightId);

      if (leftDone && rightDone) {
        // Both children are ready! Build the application.
        const left = cache.get(leftId)!;
        const right = cache.get(rightId)!;

        // Reconstruct the application and cache it
        cache.set(id, apply(left, right));
        stack.pop();
      } else {
        // Children not ready. Push them to the stack to be processed.
        // Push RIGHT then LEFT so that LEFT is processed first (LIFO)
        if (!rightDone) stack.push(rightId);
        if (!leftDone) stack.push(leftId);
      }
    }
  }

  return cache.get(rootId)!;
}

export interface ArenaWasmExports {
  /* arena API */
  reset(): void;
  allocTerminal(sym: number): number;
  allocCons(l: number, r: number): number;
  arenaKernelStep(expr: number): number;
  reduce(expr: number, max: number): number;

  kindOf(id: number): number;
  symOf(id: number): number;
  leftOf(id: number): number;
  rightOf(id: number): number;

  /* SAB bootstrap (wasm32) */
  initArena?(initialCapacity: number): number;
  connectArena?(arenaPointer: number): number;

  /* Debug/Diagnostic functions */
  debugLockState?(): number;
  getArenaMode?(): number;
  debugCalculateArenaSize?(capacity: number): number;
  debugGetMemorySize?(): number;
  debugGetArenaBaseAddr?(): number;
  debugGetLockAcquisitionCount?(): number;
  debugGetLockReleaseCount?(): number;
}

// deno-lint-ignore ban-types
function assertFn(obj: unknown, name: string): asserts obj is Function {
  if (typeof obj !== "function") {
    throw new TypeError(`WASM export \`${name}\` is missing or not a function`);
  }
}

export class ArenaEvaluatorWasm implements Evaluator {
  public readonly $: ArenaWasmExports;
  public readonly memory: WebAssembly.Memory;

  protected constructor(exports: ArenaWasmExports, memory: WebAssembly.Memory) {
    this.$ = exports;
    this.memory = memory;
  }

  /**
   * Instantiate a WASM arena evaluator with a fresh shared memory layout.
   * Always allocates its own WebAssembly.Memory configured for 4GB max.
   */
  static instantiateFromBytes(wasmBytes: BufferSource): ArenaEvaluatorWasm {
    const wasmMemory = new WebAssembly.Memory({
      initial: 256, // Start with 16MB (256 pages)
      maximum: 65536, // Max 4GB (65536 pages)
      shared: true, // Enable SharedArrayBuffer support
    });

    const imports = {
      env: {
        memory: wasmMemory,
      },
    } as WebAssembly.Imports;

    const module = new WebAssembly.Module(bufferSourceToArrayBuffer(wasmBytes));
    const instance = new WebAssembly.Instance(module, imports);
    const normalized = ArenaEvaluatorWasm.normalizeExports(instance.exports);
    return ArenaEvaluatorWasm.fromInstance(normalized, wasmMemory);
  }

  private static normalizeExports(raw: WebAssembly.Exports): ArenaWasmExports {
    const e = raw as Record<string, unknown>;
    return {
      ...(raw as Record<string, unknown>),
      debugLockState: e.debugLockState as (() => number) | undefined,
      getArenaMode: e.getArenaMode as (() => number) | undefined,
      debugCalculateArenaSize: e.debugCalculateArenaSize as
        | ((c: number) => number)
        | undefined,
      debugGetMemorySize: e.debugGetMemorySize as (() => number) | undefined,
      debugGetArenaBaseAddr: e.debugGetArenaBaseAddr as
        | (() => number)
        | undefined,
      debugGetLockAcquisitionCount: e.debugGetLockAcquisitionCount as
        | (() => number)
        | undefined,
      debugGetLockReleaseCount: e.debugGetLockReleaseCount as
        | (() => number)
        | undefined,
    } as ArenaWasmExports;
  }

  private static fromInstance(
    instance: ArenaWasmExports,
    memory: WebAssembly.Memory,
  ): ArenaEvaluatorWasm {
    const ex = instance as unknown as Record<string, unknown>;

    const required = [
      "reset",
      "allocTerminal",
      "allocCons",
      "arenaKernelStep",
      "reduce",
      "kindOf",
      "symOf",
      "leftOf",
      "rightOf",
    ] as const;

    required.forEach((k) => {
      if (!(k in ex)) throw new Error(`WASM export \`${k}\` is missing`);
    });

    assertFn(ex.reset, "reset");
    assertFn(ex.allocTerminal, "allocTerminal");
    assertFn(ex.allocCons, "allocCons");
    assertFn(ex.arenaKernelStep, "arenaKernelStep");
    assertFn(ex.reduce, "reduce");
    assertFn(ex.kindOf, "kindOf");
    assertFn(ex.symOf, "symOf");
    assertFn(ex.leftOf, "leftOf");
    assertFn(ex.rightOf, "rightOf");

    const evaluator = new ArenaEvaluatorWasm(
      instance as unknown as ArenaWasmExports,
      memory,
    );
    evaluator.reset();
    return evaluator;
  }

  stepOnce(expr: SKIExpression): { altered: boolean; expr: SKIExpression } {
    const next = this.$.arenaKernelStep(this.toArena(expr));
    return {
      altered: next !== this.toArena(expr),
      expr: this.fromArena(next),
    } as const;
  }

  reduce(expr: SKIExpression, max = 0xffffffff): SKIExpression {
    return this.fromArena(this.$.reduce(this.toArena(expr), max));
  }

  reset(): void {
    this.$.reset();
  }

  toArena(exp: SKIExpression): ArenaNodeId {
    return toArenaWithExports(exp, this.$);
  }

  fromArena(id: ArenaNodeId): SKIExpression {
    return fromArenaWithExports(id, this.$);
  }

  dumpArena(): { nodes: ArenaNode[] } {
    const nodes: Array<
      | { id: number; kind: "terminal"; sym: string }
      | { id: number; kind: "non-terminal"; left: number; right: number }
    > = [];

    for (let id = 0;; id++) {
      const k = this.$.kindOf(id);
      // kindOf returns 0 for uninitialised slots; once we hit the first zero we
      // have traversed the allocated prefix because ids are assigned densely.
      if (k === 0) break;

      if (k === (ArenaKind.Terminal as number)) {
        let sym: string;
        switch (this.$.symOf(id) as ArenaSym) {
          case ArenaSym.S:
            sym = "S";
            break;
          case ArenaSym.K:
            sym = "K";
            break;
          case ArenaSym.I:
            sym = "I";
            break;
          default:
            sym = "?";
        }
        nodes.push({ id, kind: "terminal", sym });
      } /* Non-terminal */ else {
        nodes.push({
          id,
          kind: "non-terminal",
          left: this.$.leftOf(id),
          right: this.$.rightOf(id),
        });
      }
    }

    return { nodes } as const;
  }
}

/**
 * Synchronously creates an arena evaluator using the embedded release WASM
 * bytes. This is primarily used by the CLI bundle and other environments where
 * asynchronous initialisation is undesirable.
 */
export function createArenaEvaluatorReleaseSync(): ArenaEvaluatorWasm {
  const evaluator = ArenaEvaluatorWasm.instantiateFromBytes(
    getEmbeddedReleaseWasm().slice(),
  );
  return evaluator;
}

export function createArenaEvaluator(): ArenaEvaluatorWasm {
  return createArenaEvaluatorReleaseSync();
}

export const createArenaEvaluatorRelease = createArenaEvaluatorReleaseSync;

// Homeomorphic embedding: a ⊑ b
// Returns true if a embeds into b
function embedsRec(
  nodes: ArenaNode[],
  a: number,
  b: number,
  visited: Set<string>,
): boolean {
  const key = `${a},${b}`;
  if (visited.has(key)) return false;
  visited.add(key);

  const nodeA = nodes.find((n) => n.id === a);
  const nodeB = nodes.find((n) => n.id === b);

  if (!nodeA || !nodeB) return false;

  // If a is terminal, b must be the same terminal
  if (nodeA.kind === "terminal") {
    return nodeB.kind === "terminal" && nodeA.sym === nodeB.sym;
  }

  // If a is non-terminal (APP), b must also be non-terminal
  if (nodeB.kind === "terminal") return false;

  // For APP nodes, check embedding recursively
  return (
    embedsRec(nodes, nodeA.left!, nodeB.left!, visited) &&
    embedsRec(nodes, nodeA.right!, nodeB.right!, visited)
  );
}

export function embeds(nodes: ArenaNode[], a: number, b: number): boolean {
  return embedsRec(nodes, a, b, new Set());
}

export function hasEmbedding(
  nodes: ArenaNode[],
  history: number[],
  currentId: number,
): boolean {
  for (const prevId of history) {
    if (embeds(nodes, prevId, currentId)) {
      return true;
    }
  }
  return false;
}

function bufferSourceToUint8Array(bytes: BufferSource): Uint8Array {
  if (bytes instanceof Uint8Array) return bytes;
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
  return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function bufferSourceToArrayBuffer(bytes: BufferSource): ArrayBuffer {
  if (bytes instanceof ArrayBuffer) return bytes;
  const view = bufferSourceToUint8Array(bytes).slice();
  return view.buffer as ArrayBuffer;
}
