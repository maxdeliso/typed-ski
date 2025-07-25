import { promises as fs } from "node:fs";

import { cons } from "../cons.ts";
import type { SKIExpression } from "../ski/expression.ts";
import { I, K, S, SKITerminalSymbol } from "../ski/terminal.ts";
import type { Evaluator } from "./evaluator.ts";
import { ArenaKind, type ArenaNodeId, ArenaSym } from "../shared/arena.ts";

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
    wasmPath: string,
  ): Promise<ArenaEvaluatorWasm> {
    const bytes = await fs.readFile(wasmPath);
    const { instance } = await WebAssembly.instantiate(
      bytes,
    );

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

  stepOnce(expr: SKIExpression) {
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

    return cons(
      this.fromArena(this.$.leftOf(id)),
      this.fromArena(this.$.rightOf(id)),
    );
  }

  dumpArena() {
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

export async function initArenaEvaluator(wasmPath: string) {
  return await ArenaEvaluatorWasm.instantiate(wasmPath);
}
