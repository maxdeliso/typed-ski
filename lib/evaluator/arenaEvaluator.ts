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

interface ArenaWasmExports {
  memory: WebAssembly.Memory;

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
}

// deno-lint-ignore ban-types
function assertFn(obj: unknown, name: string): asserts obj is Function {
  if (typeof obj !== "function") {
    throw new TypeError(`WASM export \`${name}\` is missing or not a function`);
  }
}

function assertMemory(
  obj: unknown,
  name: string,
): asserts obj is WebAssembly.Memory {
  if (!(obj instanceof WebAssembly.Memory)) {
    throw new TypeError(
      `WASM export \`${name}\` is missing or not a WebAssembly.Memory`,
    );
  }
}

export class ArenaEvaluatorWasm implements Evaluator {
  private readonly $: ArenaWasmExports;

  private constructor(exports: ArenaWasmExports) {
    this.$ = exports;
  }

  static async instantiate(
    wasmBytes: BufferSource,
  ): Promise<ArenaEvaluatorWasm> {
    const { instance } = await WebAssembly.instantiate(wasmBytes);

    const ex = instance.exports as Record<string, unknown>;

    const required = [
      "memory",
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

    assertMemory(ex.memory, "memory");
    assertFn(ex.reset, "reset");
    assertFn(ex.allocTerminal, "allocTerminal");
    assertFn(ex.allocCons, "allocCons");
    assertFn(ex.arenaKernelStep, "arenaKernelStep");
    assertFn(ex.reduce, "reduce");
    assertFn(ex.kindOf, "kindOf");
    assertFn(ex.symOf, "symOf");
    assertFn(ex.leftOf, "leftOf");
    assertFn(ex.rightOf, "rightOf");

    const evaluator = new ArenaEvaluatorWasm(ex as unknown as ArenaWasmExports);
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
    switch (exp.kind) {
      case "terminal":
        switch (exp.sym) {
          case SKITerminalSymbol.S:
            return this.$.allocTerminal(ArenaSym.S);
          case SKITerminalSymbol.K:
            return this.$.allocTerminal(ArenaSym.K);
          case SKITerminalSymbol.I:
            return this.$.allocTerminal(ArenaSym.I);
          default:
            throw new Error("unrecognised terminal symbol");
        }

      case "non-terminal":
        return this.$.allocCons(this.toArena(exp.lft), this.toArena(exp.rgt));
    }
  }

  fromArena(id: ArenaNodeId): SKIExpression {
    if (this.$.kindOf(id) === ArenaKind.Terminal as number) {
      switch (this.$.symOf(id) as ArenaSym) {
        case ArenaSym.S:
          return S;
        case ArenaSym.K:
          return K;
        case ArenaSym.I:
          return I;
        default:
          throw new Error("corrupt symbol tag in arena");
      }
    }

    return apply(
      this.fromArena(this.$.leftOf(id)),
      this.fromArena(this.$.rightOf(id)),
    );
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

export async function initArenaEvaluator(wasmBytes: BufferSource) {
  return await ArenaEvaluatorWasm.instantiate(wasmBytes);
}

// Memoized WASM loader functions
let cachedDebugEvaluator: Promise<ArenaEvaluatorWasm> | null = null;
let cachedReleaseEvaluator: Promise<ArenaEvaluatorWasm> | null = null;
let cachedDebugBytes: Promise<ArrayBuffer> | null = null;
let cachedReleaseBytes: Promise<ArrayBuffer> | null = null;

/**
 * Creates an arena evaluator using the debug WASM binary.
 * This function is memoized and will reuse the same instance across calls.
 *
 * @returns A promise that resolves to a ready-to-use arena evaluator
 * @example
 * ```ts
 * const evaluator = await createArenaEvaluator();
 * const result = evaluator.reduce(parseSKI("(K S) I"));
 * ```
 */
export async function createArenaEvaluator(): Promise<ArenaEvaluatorWasm> {
  if (cachedDebugEvaluator === null) {
    cachedDebugEvaluator = (async () => {
      const bytes = await getWasmBytes();
      return await ArenaEvaluatorWasm.instantiate(bytes);
    })();
  }
  return await cachedDebugEvaluator;
}

/**
 * Creates an arena evaluator using the release WASM binary.
 * This function is memoized and will reuse the same instance across calls.
 *
 * @returns A promise that resolves to a ready-to-use arena evaluator
 * @example
 * ```ts
 * const evaluator = await createArenaEvaluatorRelease();
 * const result = evaluator.reduce(parseSKI("(K S) I"));
 * ```
 */
export async function createArenaEvaluatorRelease(): Promise<
  ArenaEvaluatorWasm
> {
  if (cachedReleaseEvaluator === null) {
    cachedReleaseEvaluator = (async () => {
      const bytes = await getWasmBytesRelease();
      return await ArenaEvaluatorWasm.instantiate(bytes);
    })();
  }
  return await cachedReleaseEvaluator;
}

/**
 * Fetches and returns the raw ArrayBuffer of the debug WASM module.
 * This function is memoized and will reuse the same bytes across calls.
 *
 * @returns A promise that resolves to the WASM module bytes
 * @example
 * ```ts
 * const bytes = await getWasmBytes();
 * const evaluator = await ArenaEvaluatorWasm.instantiate(bytes);
 * ```
 */
export async function getWasmBytes(): Promise<ArrayBuffer> {
  if (cachedDebugBytes === null) {
    cachedDebugBytes = (async () => {
      const response = await fetch(
        new URL("../../assembly/build/debug.wasm", import.meta.url),
      );
      if (!response.ok) {
        throw new Error(
          `Failed to fetch WASM bytes: ${response.status} ${response.statusText}`,
        );
      }
      return await response.arrayBuffer();
    })();
  }
  return await cachedDebugBytes;
}

/**
 * Fetches and returns the raw ArrayBuffer of the release WASM module.
 * This function is memoized and will reuse the same bytes across calls.
 *
 * @returns A promise that resolves to the WASM module bytes
 * @example
 * ```ts
 * const bytes = await getWasmBytesRelease();
 * const evaluator = await ArenaEvaluatorWasm.instantiate(bytes);
 * ```
 */
export async function getWasmBytesRelease(): Promise<ArrayBuffer> {
  if (cachedReleaseBytes === null) {
    cachedReleaseBytes = (async () => {
      const response = await fetch(
        new URL("../../assembly/build/release.wasm", import.meta.url),
      );
      if (!response.ok) {
        throw new Error(
          `Failed to fetch WASM bytes: ${response.status} ${response.statusText}`,
        );
      }
      return await response.arrayBuffer();
    })();
  }
  return await cachedReleaseBytes;
}

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
