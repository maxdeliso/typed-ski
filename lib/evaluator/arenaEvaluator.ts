/**
 * WebAssembly-based arena evaluator for SKI expressions.
 *
 * This module provides a WebAssembly-based evaluator for SKI expressions
 * using arena-based memory management for efficient evaluation.
 *
 * @module
 */

import type { SKIExpression } from "../ski/expression.ts";
import { apply, unparseSKI } from "../ski/expression.ts";
import { SKITerminalSymbol } from "../ski/terminal.ts";
import type { Evaluator } from "./evaluator.ts";
import {
  ARENA_SYM_TO_SKI,
  ArenaKind,
  type ArenaNodeId,
  ArenaSym,
  isControlPtr,
} from "../shared/arena.ts";
import type { ArenaNode } from "../shared/types.ts";
import {
  getReleaseWasmBytes,
  getReleaseWasmBytesSync,
} from "./arenaWasmLoader.ts";
import {
  getKind as viewGetKind,
  getLeft as viewGetLeft,
  getOrBuildArenaViews,
  getRight as viewGetRight,
  getSym as viewGetSym,
  validateAndRebuildViews,
} from "./arenaViews.ts";
import {
  SABHEADER_HEADER_SIZE_U32,
  SabHeaderField,
} from "./arenaHeader.generated.ts";

/**
 * Terminal cache: Maps exports instance -> {S, K, I, ...} IDs
 * This allows each evaluator instance to have its own terminal cache
 */
const terminalCache = new WeakMap<
  Pick<ArenaWasmExports, "allocTerminal">,
  {
    s: number;
    k: number;
    i: number;
    b: number;
    c: number;
    sPrime: number;
    bPrime: number;
    cPrime: number;
    readOne: number;
    writeOne: number;
    eqU8: number;
    ltU8: number;
    divU8: number;
    modU8: number;
    addU8: number;
    subU8: number;
  }
>();

const DEFAULT_WASM_ARENA_MAX_CAPACITY = 1 << 20;

/**
 * Convert an SKI expression to an arena node ID.
 * Shared utility function used by both ArenaEvaluatorWasm and arenaWorker.
 *
 * Uses iterative processing with memoization to:
 * 1. Avoid call stack overflow on deep structures
 * 2. Deduplicate shared nodes (DAGs) to prevent unnecessary allocations
 * 3. Cache terminal symbols to avoid repeated WASM calls
 */
function toArenaWithExports(
  root: SKIExpression,
  exports: Pick<
    ArenaWasmExports,
    "allocTerminal" | "allocCons" | "allocU8"
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
      b: exports.allocTerminal(ArenaSym.B),
      c: exports.allocTerminal(ArenaSym.C),
      sPrime: exports.allocTerminal(ArenaSym.SPrime),
      bPrime: exports.allocTerminal(ArenaSym.BPrime),
      cPrime: exports.allocTerminal(ArenaSym.CPrime),
      readOne: exports.allocTerminal(ArenaSym.ReadOne),
      writeOne: exports.allocTerminal(ArenaSym.WriteOne),
      eqU8: exports.allocTerminal(ArenaSym.EqU8),
      ltU8: exports.allocTerminal(ArenaSym.LtU8),
      divU8: exports.allocTerminal(ArenaSym.DivU8),
      modU8: exports.allocTerminal(ArenaSym.ModU8),
      addU8: exports.allocTerminal(ArenaSym.AddU8),
      subU8: exports.allocTerminal(ArenaSym.SubU8),
    };
    terminalCache.set(exports, cache);
  }

  // 2. Memoization Map: SKIExpression (JS Object) -> ArenaNodeId (WASM Int)
  // This dedups shared references (DAGs) on the fly, preventing unnecessary allocations.
  const exprCache = new Map<SKIExpression, number>();
  // Structural hash-consing: (leftId,rightId) -> ArenaNodeId.
  // This catches equivalent subtrees even when they are distinct JS objects.
  const consCache = new Map<string, number>();

  // 3. Explicit Stack for Iterative Post-Order Traversal
  const stack: SKIExpression[] = [root];

  while (stack.length > 0) {
    // Peek at the top node
    const expr = stack[stack.length - 1]!;

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
        case SKITerminalSymbol.B:
          id = cache.b;
          break;
        case SKITerminalSymbol.C:
          id = cache.c;
          break;
        case SKITerminalSymbol.SPrime:
          id = cache.sPrime;
          break;
        case SKITerminalSymbol.BPrime:
          id = cache.bPrime;
          break;
        case SKITerminalSymbol.CPrime:
          id = cache.cPrime;
          break;
        case SKITerminalSymbol.ReadOne:
          id = cache.readOne;
          break;
        case SKITerminalSymbol.WriteOne:
          id = cache.writeOne;
          break;
        case SKITerminalSymbol.EqU8:
          id = cache.eqU8;
          break;
        case SKITerminalSymbol.LtU8:
          id = cache.ltU8;
          break;
        case SKITerminalSymbol.DivU8:
          id = cache.divU8;
          break;
        case SKITerminalSymbol.ModU8:
          id = cache.modU8;
          break;
        case SKITerminalSymbol.AddU8:
          id = cache.addU8;
          break;
        case SKITerminalSymbol.SubU8:
          id = cache.subU8;
          break;
        default:
          throw new Error("Unrecognised terminal symbol");
      }
      exprCache.set(expr, id);
      stack.pop();
    } else if (expr.kind === "u8") {
      const id = exports.allocU8(expr.value);
      if (id === EMPTY) {
        throw new Error("Arena Out of Memory during U8 marshaling");
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
        // Both children are ready.
        // First try structural reuse before allocating a fresh cons cell.
        const consKey = `${leftId},${rightId}`;
        let id = consCache.get(consKey);
        if (id === undefined) {
          id = exports.allocCons(leftId, rightId);
          if (id === EMPTY) {
            throw new Error("Arena Out of Memory during marshaling");
          }
          consCache.set(consKey, id);
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
function fromArenaWithExports(
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

  // Helper functions to get node data from views or WASM calls (AoS layout)
  const getKind = (id: number): number => {
    return views && id < views.capacity
      ? viewGetKind(id, views)
      : exports.kindOf(id);
  };
  const getSym = (id: number): number => {
    return views && id < views.capacity
      ? viewGetSym(id, views)
      : exports.symOf(id);
  };

  while (stack.length > 0) {
    // Peek at the current node (don't pop yet, we might need to push children)
    const id = stack[stack.length - 1]!;

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
    if (isControlPtr(id)) {
      throw new Error(
        `Cannot convert control pointer ${
          id >>> 0
        } to SKI expression. Control arena state must not leak into value results.`,
      );
    }
    const kind = getKind(id);

    if (kind === 1) { // ArenaKind.Terminal
      // TERMINAL: Construct immediately and cache
      const sym = getSym(id);
      cache.set(id, ARENA_SYM_TO_SKI[sym as ArenaSym]!);
      stack.pop();
    } else if (kind === ArenaKind.U8) {
      const value = getSym(id);
      cache.set(id, { kind: "u8", value });
      stack.pop();
    } else if (kind === ArenaKind.NonTerm) {
      // NON-TERMINAL: Check children (AoS: use view getters when available)
      const leftId = views && id < views.capacity
        ? viewGetLeft(id, views)
        : exports.leftOf(id);
      const rightId = views && id < views.capacity
        ? viewGetRight(id, views)
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
    } else {
      throw new Error(
        `Cannot convert arena node ${
          id >>> 0
        } with kind ${kind} to SKI expression.`,
      );
    }
  }

  return cache.get(rootId)!;
}

export interface ArenaWasmExports {
  /* arena API */
  reset(): void;
  allocTerminal(sym: number): number;
  allocCons(l: number, r: number): number;
  allocU8(value: number): number;
  arenaKernelStep(expr: number): number;
  reduce(expr: number, max: number): number;
  hostSubmit?(nodeId: number, reqId: number, maxSteps: number): number;
  hostPullV2?(): bigint;
  workerLoop?(workerId: number): void;
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

  public constructor(exports: ArenaWasmExports, memory: WebAssembly.Memory) {
    this.$ = exports;
    this.memory = memory;
  }

  /**
   * Instantiate a WASM arena evaluator with a fresh shared memory layout.
   * Always allocates its own WebAssembly.Memory configured for the largest
   * practical wasm32 shared-memory maximum.
   */
  static instantiateFromBytes(wasmBytes: BufferSource): ArenaEvaluatorWasm {
    const MAX_PAGES = 65535;
    const wasmMemory = new WebAssembly.Memory({
      // Bazel-built release.wasm now declares a 257-page shared-memory minimum,
      // so the sync evaluator must allocate at least that much imported memory.
      initial: 257,
      maximum: MAX_PAGES,
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

  public static normalizeExports(raw: WebAssembly.Exports): ArenaWasmExports {
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

  public static fromInstance(
    instance: ArenaWasmExports,
    memory: WebAssembly.Memory,
  ): ArenaEvaluatorWasm {
    const ex = instance as unknown as Record<string, unknown>;

    const required = [
      "reset",
      "allocTerminal",
      "allocCons",
      "allocU8",
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
    assertFn(ex.allocU8, "allocU8");
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
    if (instance.initArena) {
      const result = instance.initArena(DEFAULT_WASM_ARENA_MAX_CAPACITY);
      if (result === 0) {
        throw new Error(
          `initArena failed for capacity ${DEFAULT_WASM_ARENA_MAX_CAPACITY}`,
        );
      }
    }
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

  /**
   * Connect this evaluator to an existing arena at the specified memory address.
   * Invalidates the terminal cache to ensure consistency with the new arena.
   */
  connectArena(arenaPointer: number): number {
    if (!this.$.connectArena) {
      throw new Error("connectArena export is missing");
    }
    const rc = this.$.connectArena(arenaPointer);
    if (rc === 1) {
      terminalCache.delete(
        this.$ as unknown as Pick<ArenaWasmExports, "allocTerminal">,
      );
    }
    return rc;
  }

  hostSubmit(nodeId: number, reqId: number, maxSteps: number): number {
    const $ = this.$;
    if (!$?.hostSubmit) throw new Error("hostSubmit export missing");
    return $.hostSubmit(nodeId >>> 0, reqId >>> 0, maxSteps >>> 0);
  }

  hostPullV2(): bigint {
    const $ = this.$;
    if (!$?.hostPullV2) throw new Error("hostPullV2 export missing");
    return $.hostPullV2();
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
  protected getArenaTop(): number {
    const baseAddr = this.$.debugGetArenaBaseAddr?.();
    if (!baseAddr) return 0;

    const headerView = new Uint32Array(
      this.memory.buffer,
      baseAddr,
      SABHEADER_HEADER_SIZE_U32,
    );
    return headerView[SabHeaderField.TOP]!;
  }

  /**
   * Helper: Decodes a single node ID into an ArenaNode object.
   * Returns null if the slot is uninitialized (a "hole").
   */
  protected getArenaNode(
    id: number,
    views: ReturnType<typeof getOrBuildArenaViews>,
  ): ArenaNode | null {
    // 1. Determine Kind (AoS: use view getters when available)
    let k: number;
    if (views && id < views.capacity) {
      if ((k = viewGetKind(id, views)) === 0) return null; // Hole/uninitialized
    } else {
      if ((k = this.$.kindOf(id)) === 0) return null; // Hole/uninitialized
    }

    // 2. Build Terminal
    if (k === 1) { // ArenaKind.Terminal
      const symValue = views && id < views.capacity
        ? viewGetSym(id, views)
        : this.$.symOf(id);

      const expr = ARENA_SYM_TO_SKI[symValue as ArenaSym]!;
      return { id, kind: "terminal", sym: unparseSKI(expr) };
    }

    // 2b. Build U8 literal (display as #u8(n))
    if (k === ArenaKind.U8) {
      const symValue = views && id < views.capacity
        ? viewGetSym(id, views)
        : this.$.symOf(id);
      return { id, kind: "terminal", sym: `#u8(${symValue})` };
    }

    // 3. Build Non-Terminal
    const left = views && id < views.capacity
      ? viewGetLeft(id, views)
      : this.$.leftOf(id);
    const right = views && id < views.capacity
      ? viewGetRight(id, views)
      : this.$.rightOf(id);

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
        yield [...chunk];
        chunk.length = 0;
      }
    }

    if (chunk.length > 0) {
      yield [...chunk];
    }
  }
}

/**
 * Synchronously creates an arena evaluator using `wasm/release.wasm` from the
 * package layout.
 *
 * Note: this requires a sync-readable file URL (Deno runtime). In other
 * environments, use `createArenaEvaluator()` instead.
 */
export function createArenaEvaluatorReleaseSync(): ArenaEvaluatorWasm {
  const evaluator = ArenaEvaluatorWasm.instantiateFromBytes(
    getReleaseWasmBytesSync(),
  );
  return evaluator;
}

export async function createArenaEvaluator(): Promise<ArenaEvaluatorWasm> {
  const evaluator = ArenaEvaluatorWasm.instantiateFromBytes(
    await getReleaseWasmBytes(),
  );
  return evaluator;
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
