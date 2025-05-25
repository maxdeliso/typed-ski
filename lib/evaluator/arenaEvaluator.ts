import { promises as fs } from 'node:fs';

import { cons } from '../cons.js';
import { SKIExpression } from '../ski/expression.js';
import { S, K, I, SKITerminalSymbol } from '../ski/terminal.js';
import { Evaluator } from './evaluator.js';
import { ArenaKind, ArenaSym, ArenaNodeId } from '../shared/arena.js';

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

// eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
function assertFn(obj: unknown, name: string): asserts obj is Function {
  if (typeof obj !== 'function') {
    throw new TypeError(`WASM export \`${name}\` is missing or not a function`);
  }
}

function assertMemory(obj: unknown, name: string): asserts obj is WebAssembly.Memory {
  if (!(obj instanceof WebAssembly.Memory)) {
    throw new TypeError(`WASM export \`${name}\` is missing or not a WebAssembly.Memory`);
  }
}

export class ArenaEvaluatorWasm implements Evaluator {
  private readonly $: ArenaWasmExports;

  private constructor(exports: ArenaWasmExports) {
    this.$ = exports;
  }

  static async instantiate(wasmPath: string | URL): Promise<ArenaEvaluatorWasm> {
    const bytes = await fs.readFile(wasmPath);
    const memory = new WebAssembly.Memory({
      initial: 512,      // 32 MiB
      maximum: 65_536,   // 4 GiB
    });

    const abortFn = (msgPtr: number, filePtr: number, line: number, col: number) => {
      console.error('abort', { line, col });
    };

    const importObject = {
      env: { memory, abort: abortFn },
      "arena-evaluator": { abort: abortFn }
    };

    const { instance } = await WebAssembly.instantiate(bytes, importObject);
    const ex = instance.exports as Record<string, unknown>;

    const required = [
      'memory',
      'reset',
      'allocTerminal',
      'allocCons',
      'arenaKernelStep',
      'reduce',
      'kindOf',
      'symOf',
      'leftOf',
      'rightOf',
    ] as const;

    required.forEach((k) => {
      if (!(k in ex)) throw new Error(`WASM export \`${k}\` is missing`);
    });

    assertMemory(ex.memory, 'memory');
    assertFn(ex.reset, 'reset');
    assertFn(ex.allocTerminal, 'allocTerminal');
    assertFn(ex.allocCons, 'allocCons');
    assertFn(ex.arenaKernelStep, 'arenaKernelStep');
    assertFn(ex.reduce, 'reduce');
    assertFn(ex.kindOf, 'kindOf');
    assertFn(ex.symOf, 'symOf');
    assertFn(ex.leftOf, 'leftOf');
    assertFn(ex.rightOf, 'rightOf');

    const evaluator = new ArenaEvaluatorWasm(ex as unknown as ArenaWasmExports);
    evaluator.reset();
    return evaluator;
  }

  stepOnce(expr: SKIExpression) {
    const next = this.$.arenaKernelStep(this.toArena(expr));
    return {
      altered: next !== this.toArena(expr),
      expr: this.fromArena(next)
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
      case 'terminal':
        switch (exp.sym) {
          case SKITerminalSymbol.S:
            return this.$.allocTerminal(ArenaSym.S);
          case SKITerminalSymbol.K:
            return this.$.allocTerminal(ArenaSym.K);
          case SKITerminalSymbol.I:
            return this.$.allocTerminal(ArenaSym.I);
          default:
            throw new Error('unrecognised terminal symbol');
        }

      case 'non-terminal':
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
          throw new Error('corrupt symbol tag in arena');
      }
    }

    return cons(
      this.fromArena(this.$.leftOf(id)),
      this.fromArena(this.$.rightOf(id))
    );
  }
}

export async function initArenaEvaluator(wasmPath: string | URL) {
  return ArenaEvaluatorWasm.instantiate(wasmPath);
}
