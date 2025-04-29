import { cons } from '../cons.js';
import { EMPTY, ArenaKind, ArenaNodeId as ArenaNodeId, ArenaSym } from '../ski/arena.js';
import { SKIExpression } from '../ski/expression.js';
import { I, K, S, SKITerminalSymbol } from '../ski/terminal.js';
import { Evaluator } from './evaluator.js';

const CAP = 1 << 22;
const kind      = new Uint8Array(CAP);
const sym       = new Uint8Array(CAP);
const leftId    = new Uint32Array(CAP);
const rightId   = new Uint32Array(CAP);
const hash32    = new Uint32Array(CAP);
const nextIdx   = new Uint32Array(CAP);
let   top       = 0; // bump pointer

const bucketShift = 16; // 65 536 buckets
const buckets     = new Uint32Array(1 << bucketShift).fill(EMPTY);
const mask      = (1 << bucketShift) - 1;

// see https://github.com/aappleby/smhasher
// this is a fast integer scrambler with nice distribution properties
function avalanche32(x: number): number {
  x = (x ^ (x >>> 16)) >>> 0;
  x = (x * 0x7feb352d) >>> 0;
  x = (x ^ (x >>> 15)) >>> 0;
  x = (x * 0x846ca68b) >>> 0;
  x = (x ^ (x >>> 16)) >>> 0;
  return x >>> 0;
}

const isTerminal = (n: ArenaNodeId) => (kind[n] as ArenaKind) === ArenaKind.Terminal;
const symOf      = (n: ArenaNodeId) => sym[n] as ArenaSym;
const leftOf     = (n: ArenaNodeId) => leftId[n];
const rightOf    = (n: ArenaNodeId) => rightId[n];

// Donald Knuth’s multiplicative-hash suggestion in The Art of Computer Programming, Vol 3 (section 6.4, 2nd ed., §3.2).
const GOLD = 0x9e3779b9;
const mix = (a: number, b: number) => avalanche32((a ^ (b * GOLD)) >>> 0);

// make identical leaves pointer-equal
const termIds: Partial<Record<ArenaSym, ArenaNodeId>> = {};

function arenaTerminal(symVal: ArenaSym): ArenaNodeId {
  const cached = termIds[symVal];
  if (cached !== undefined) return cached; // ← reuse

  const id = top++;
  kind[id]   = ArenaKind.Terminal;
  sym[id]    = symVal;
  hash32[id] = symVal; // injective over {1,2,3}
  termIds[symVal] = id; // remember for next time
  return id;
}

function arenaCons(l: ArenaNodeId, r: ArenaNodeId): ArenaNodeId {
  const h = mix(hash32[l], hash32[r]);
  const b = h & mask;

  /* lookup */
  for (let i = buckets[b]; i !== EMPTY; i = nextIdx[i]) {
    if (hash32[i] === h && leftId[i] === l && rightId[i] === r) return i;
  }

  /* miss → allocate */
  const id = top++;
  kind[id]    = ArenaKind.NonTerm;
  leftId[id]  = l;
  rightId[id] = r;
  hash32[id]  = h;
  nextIdx[id] = buckets[b];
  buckets[b]  = id;
  return id;
}

function arenaKernelStep(expr: ArenaNodeId): { altered: boolean; expr: ArenaNodeId } {
  if(isTerminal(expr)) {
    return {
      altered: false,
      expr
    };
  }

  if (isTerminal(leftOf(expr)) && symOf(leftOf(expr)) === ArenaSym.I) {
    return {
      altered: true,
      expr: rightOf(expr)
    };
  }

  if (!isTerminal(leftOf(expr)) &&
      isTerminal(leftOf(leftOf(expr))) &&
      symOf(leftOf(leftOf(expr))) === ArenaSym.K) {

    return {
      altered: true,
      expr: rightOf(leftOf(expr))
    };
  }

  if (!isTerminal(leftOf(expr)) &&
      !isTerminal(leftOf(leftOf(expr))) &&
      isTerminal(leftOf(leftOf(leftOf(expr)))) &&
      symOf(leftOf(leftOf(leftOf(expr)))) === ArenaSym.S) {

    const x = rightOf(leftOf(leftOf(expr)));
    const y = rightOf(leftOf(expr));
    const z = rightOf(expr);
    return {
      altered: true,
      expr: arenaCons(arenaCons(x, z), arenaCons(y, z)),
    };
  }

  const leftRes = arenaKernelStep(leftOf(expr));

  if (leftRes.altered) {
    return {
      altered: true,
      expr: arenaCons(leftRes.expr, rightOf(expr)),
    };
  }

  const rightRes = arenaKernelStep(rightOf(expr));

  if (rightRes.altered) {
    return {
      altered: true,
      expr: arenaCons(leftOf(expr), rightRes.expr),
    };
  }

  return { altered: false, expr };
}

export const arenaEvaluator: Evaluator<ArenaNodeId> = {
  stepOnce: arenaKernelStep,
  reduce(expr: ArenaNodeId, max = Infinity) {
    let cur = expr;
    for (let i = 0; i < max; i++) {
      const r = arenaKernelStep(cur);
      if (!r.altered) return r.expr;
      cur = r.expr;
    }
    return cur;
  },
};

export function toArena(exp: SKIExpression): ArenaNodeId {
  switch(exp.kind) {
    case 'terminal':
      switch (exp.sym) {
        case SKITerminalSymbol.S:
          return arenaTerminal(ArenaSym.S);
        case SKITerminalSymbol.K:
          return arenaTerminal(ArenaSym.K);
        case SKITerminalSymbol.I:
          return arenaTerminal(ArenaSym.I);
        default:
          throw new Error('unrecognized terminal');
      }

    case 'non-terminal':
      return arenaCons(toArena(exp.lft), toArena(exp.rgt));
  }
}

export function fromArena(ni: ArenaNodeId): SKIExpression {
  if (isTerminal(ni)) {
    switch(symOf(ni)) {
      case ArenaSym.S:
        return S;
      case ArenaSym.K:
        return K;
      case ArenaSym.I:
        return I;
      default:
        throw new Error('corrupt symbol');
    }
  }

  return cons(fromArena(leftOf(ni)), fromArena(rightOf(ni)));
}
