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
import { type ArenaNodeId, ArenaSym } from "../shared/arena.ts";
import type { ArenaNode } from "../shared/types.ts";
import { getEmbeddedReleaseWasm } from "./arenaWasm.embedded.ts";
import { getOrBuildArenaViews, validateAndRebuildViews } from "./arenaViews.ts";
import { SabHeaderField } from "./arenaHeader.generated.ts";

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
 * 3. Uses direct memory views instead of WASM function calls for performance
 */
export function fromArenaWithExports(
  rootId: ArenaNodeId,
  exports: Pick<
    ArenaWasmExports,
    "kindOf" | "symOf" | "leftOf" | "rightOf" | "debugGetArenaBaseAddr"
  >,
  memory?: WebAssembly.Memory,
): SKIExpression {
  // Get or build arena views with caching (initial views, set once before loop)
  const initialViews = getOrBuildArenaViews(memory, exports);
  // Current views (may be updated inside loop if arena grows)
  let views = initialViews;
  const cache = new Map<number, SKIExpression>();
  const stack: number[] = [rootId];

  // Helper functions to get node data from views or WASM calls
  const getKind = (id: number): number => {
    return views && id < views.capacity ? views.kind[id] : exports.kindOf(id);
  };
  const getSym = (id: number): number => {
    return views && id < views.capacity ? views.sym[id] : exports.symOf(id);
  };

  while (stack.length > 0) {
    // Peek at the current node (don't pop yet, we might need to push children)
    const id = stack[stack.length - 1];

    // If we've already built this node, just pop and move on
    if (cache.has(id)) {
      stack.pop();
      continue;
    }

    // Validate views are still current (arena might have grown)
    if (views) {
      const validatedViews = validateAndRebuildViews(views, memory, exports);
      if (validatedViews !== views) {
        views = validatedViews;
      }
    }

    // Use direct memory access if views are available, otherwise fall back to WASM calls
    const kind = getKind(id);

    if (kind === 1) { // ArenaKind.Terminal
      // TERMINAL: Construct immediately and cache
      const sym = getSym(id);
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
    } else if (kind === 3 || kind === 4) { // ArenaKind.Continuation || ArenaKind.Suspension
      // CONTINUATION/SUSPENSION: These are internal WASM-only nodes used for iterative reduction.
      // They should never appear in the final result, but if they do (e.g., due to a bug or
      // incomplete reduction), we cannot convert them to SKI expressions.
      // Skip them and pop from stack to avoid infinite loops.
      throw new Error(
        `Cannot convert ${
          kind === 3 ? "Continuation" : "Suspension"
        } node ${id} to SKI expression. This node type is internal to the WASM reducer and should not appear in results.`,
      );
    } else {
      // NON-TERMINAL: Check children
      // Cache views properties to avoid repeated dereferencing
      const capacity = views?.capacity;
      const leftIdArray = views?.leftId;
      const rightIdArray = views?.rightId;
      const leftId = capacity !== undefined && id < capacity
        ? leftIdArray![id]
        : exports.leftOf(id);
      const rightId = capacity !== undefined && id < capacity
        ? rightIdArray![id]
        : exports.rightOf(id);

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
  hostSubmit?(nodeId: number, reqId: number, maxSteps: number): number;
  hostPull?(): bigint;
  workerLoop?(): void;
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
  debugGetArenaBaseAddr?(): number;
  debugGetRingEntries?(): number;
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
      debugGetArenaBaseAddr: e.debugGetArenaBaseAddr as
        | (() => number)
        | undefined,
      debugGetRingEntries: e.debugGetRingEntries as (() => number) | undefined,
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

  /**
   * Perform a single evaluation step directly on an arena node ID.
   * Returns the next arena node ID, or the same ID if no reduction is possible.
   * This avoids the overhead of converting to/from SKIExpression.
   */
  stepOnceArena(arenaNodeId: ArenaNodeId): ArenaNodeId {
    return this.$.arenaKernelStep(arenaNodeId);
  }

  reduce(expr: SKIExpression, max = 0xffffffff): SKIExpression {
    return this.fromArena(this.$.reduce(this.toArena(expr), max));
  }

  reset(): void {
    this.$.reset();
    // IMPORTANT:
    // `toArenaWithExports` caches terminal node IDs (S/K/I) per exports instance.
    // A WASM-level `reset()` reclaims the arena (top=0) and clears the WASM terminal cache,
    // so previously cached terminal IDs may be reused for non-terminal nodes.
    // If we don't invalidate the JS cache here, subsequent submissions can build corrupted graphs,
    // leading to hangs or traps in the reducer.
    terminalCache.delete(
      this.$ as unknown as Pick<ArenaWasmExports, "allocTerminal">,
    );
  }

  hostSubmit(nodeId: number, reqId: number, maxSteps: number): number {
    const $ = this.$;
    if (!$?.hostSubmit) throw new Error("hostSubmit export missing");
    return $.hostSubmit(nodeId >>> 0, reqId >>> 0, maxSteps >>> 0);
  }

  hostPull(): bigint {
    const $ = this.$;
    if (!$?.hostPull) throw new Error("hostPull export missing");
    return $.hostPull();
  }

  toArena(exp: SKIExpression): ArenaNodeId {
    return toArenaWithExports(exp, this.$);
  }

  fromArena(id: ArenaNodeId): SKIExpression {
    return fromArenaWithExports(id, this.$, this.memory);
  }

  /**
   * Helper: Reads the arena header to find the number of allocated nodes.
   */
  private getArenaTop(): number {
    const baseAddr = this.$.debugGetArenaBaseAddr?.();
    if (!baseAddr) return 0;

    const headerView = new Uint32Array(this.memory.buffer, baseAddr, 32);
    return headerView[SabHeaderField.TOP];
  }

  /**
   * Helper: Decodes a single node ID into an ArenaNode object.
   * Returns null if the slot is uninitialized (a "hole").
   */
  private getArenaNode(
    id: number,
    views: ReturnType<typeof getOrBuildArenaViews>,
  ): ArenaNode | null {
    // 1. Determine Kind (Optimization: Use View if possible)
    let k: number;
    if (views && id < views.capacity) {
      if ((k = views.kind[id]) === 0) return null; // Hole/uninitialized
    } else {
      if ((k = this.$.kindOf(id)) === 0) return null; // Hole/uninitialized
    }

    // 2. Build Terminal
    if (k === 1) { // ArenaKind.Terminal
      const symValue = views && id < views.capacity
        ? views.sym[id]
        : this.$.symOf(id);

      let sym: string;
      switch (symValue as ArenaSym) {
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
      return { id, kind: "terminal", sym };
    }

    // 3. Build Non-Terminal
    let left: number;
    let right: number;
    if (views && id < views.capacity) {
      left = views.leftId[id];
      right = views.rightId[id];
    } else {
      left = this.$.leftOf(id);
      right = this.$.rightOf(id);
    }

    return { id, kind: "non-terminal", left, right };
  }

  dumpArena(): { nodes: ArenaNode[] } {
    const nodes: ArenaNode[] = [];
    const views = getOrBuildArenaViews(this.memory, this.$);
    const top = this.getArenaTop();
    let node: ArenaNode | null;

    for (let id = 0; id < top; id++) {
      node = this.getArenaNode(id, views);
      if (!node) continue; // Skip holes
      nodes.push(node);
    }

    return { nodes };
  }

  /**
   * Stream arena nodes in chunks to avoid memory issues with large arenas.
   * Yields nodes in batches for efficient processing.
   */
  *dumpArenaStreaming(
    chunkSize: number = 10000,
  ): Generator<ArenaNode[], void, unknown> {
    const views = getOrBuildArenaViews(this.memory, this.$);
    const top = this.getArenaTop();
    const chunk: ArenaNode[] = [];
    let node: ArenaNode | null;

    for (let id = 0; id < top; id++) {
      node = this.getArenaNode(id, views);
      if (!node) continue; // Skip holes

      chunk.push(node);

      if (chunk.length >= chunkSize) {
        yield chunk;
        chunk.length = 0;
      }
    }

    if (chunk.length > 0) {
      yield chunk;
    }
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
