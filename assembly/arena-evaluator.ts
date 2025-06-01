import { ArenaKind, ArenaSym } from "../lib/shared/arena";

const EMPTY: u32 = 0xffff_ffff; // sentinel

const INITIAL_CAP: u32 = 1 << 20;            // ≈ 1 048 576 nodes  (fits in 32 MiB)
const MAX_CAP: u32 = 1 << 28;            // 268 435 456 nodes ≈ 4 GiB
let cap: u32 = INITIAL_CAP;

let kind = new Uint8Array(cap);
let symArr = new Uint8Array(cap);
let leftId = new Uint32Array(cap);
let rightId = new Uint32Array(cap);
let hash32 = new Uint32Array(cap);
let nextIdx = new Uint32Array(cap);

const BUCKET_SHIFT: u32 = 16;
const N_BUCKETS: u32 = 1 << BUCKET_SHIFT; // 65 536
const buckets = new Uint32Array(N_BUCKETS);
const mask: u32 = (1 << BUCKET_SHIFT) - 1; // 0xffff

const termCache = new Uint32Array(4);

let top: u32 = 0;                    // bump‑pointer

function ensureCapacity(nodesNeeded: u32 = 1): void {
  if (top + nodesNeeded <= cap) return;

  if (cap >= MAX_CAP) {
    unreachable();
  }

  let newCap = cap << 1;                     // double
  if (newCap > MAX_CAP) newCap = MAX_CAP;
  cap = newCap;

  let k = new Uint8Array(cap); k.set(kind); kind = k;
  let sy = new Uint8Array(cap); sy.set(symArr); symArr = sy;
  let l = new Uint32Array(cap); l.set(leftId); leftId = l;
  let r = new Uint32Array(cap); r.set(rightId); rightId = r;
  let h = new Uint32Array(cap); h.set(hash32); hash32 = h;
  let n = new Uint32Array(cap); n.set(nextIdx); nextIdx = n;
}

// see https://github.com/aappleby/smhasher
// this is a fast integer scrambler with nice distribution properties
function avalanche32(x: u32): u32 {
  x = (x ^ (x >>> 16)) >>> 0;
  x = (x * 0x7feb352d) >>> 0;
  x = (x ^ (x >>> 15)) >>> 0;
  x = (x * 0x846ca68b) >>> 0;
  x = (x ^ (x >>> 16)) >>> 0;
  return x;
}

// Donald Knuth's multiplicative-hash suggestion in The Art of Computer
// Programming, Vol 3 (section 6.4, 2nd ed., §3.2).
const GOLD: u32 = 0x9e3779b9;

function mix(a: u32, b: u32): u32 {
  return avalanche32(a ^ (b * GOLD));
}

export function kindOf(n: u32): u32 {
  return kind[n];
}

export function symOf(n: u32): ArenaSym {
  return symArr[n] as ArenaSym;
}

export function leftOf(n: u32): u32 {
  return leftId[n];
}

export function rightOf(n: u32): u32 {
  return rightId[n];
}

function isTerminal(n: u32): bool {
  return kind[n] == ArenaKind.Terminal;
}

export function reset(): void {
  top = 0;
  buckets.fill(EMPTY);
  termCache.fill(EMPTY);
}

export function allocTerminal(s: ArenaSym): u32 {
  let cached = termCache[s];
  if (cached != EMPTY) return cached;

  ensureCapacity();          // ensure we have space for a new node
  let id: u32 = top++;
  kind[id] = ArenaKind.Terminal;
  symArr[id] = s;
  hash32[id] = s;
  termCache[s] = id;
  return id;
}

export function allocCons(l: u32, r: u32): u32 {
  let h: u32 = mix(hash32[l], hash32[r]);
  let b: u32 = h & mask;

  for (let i: u32 = buckets[b];
    i != EMPTY;
    i = nextIdx[i]) {
    if (hash32[i] == h &&
      leftId[i] == l &&
      rightId[i] == r) return i;
  }

  ensureCapacity();
  let id: u32 = top++;
  kind[id] = ArenaKind.NonTerm;
  leftId[id] = l;
  rightId[id] = r;
  hash32[id] = h;
  nextIdx[id] = buckets[b];
  buckets[b] = id;
  return id;
}

// A side‑channel flag: 0 = unchanged, 1 = altered during last step
let alteredLast: u32 = 0;

export function arenaKernelStep(expr: u32): u32 {
  alteredLast = 0; // reset flag
  let res = _step(expr);
  return res;
}

function _step(expr: u32): u32 {
  if (isTerminal(expr)) return expr; // no change

  /* I x ⇒ x */
  if (isTerminal(leftOf(expr)) && symOf(leftOf(expr)) == ArenaSym.I) {
    alteredLast = 1;
    return rightOf(expr);
  }

  /* (K x) y ⇒ x */
  if (!isTerminal(leftOf(expr)) &&
    isTerminal(leftOf(leftOf(expr))) &&
    symOf(leftOf(leftOf(expr))) == ArenaSym.K) {
    alteredLast = 1;
    return rightOf(leftOf(expr));
  }

  /* ((S x) y) z ⇒ (x z) (y z) */
  if (!isTerminal(leftOf(expr)) &&
    !isTerminal(leftOf(leftOf(expr))) &&
    isTerminal(leftOf(leftOf(leftOf(expr)))) &&
    symOf(leftOf(leftOf(leftOf(expr)))) == ArenaSym.S) {
    const x = rightOf(leftOf(leftOf(expr)));
    const y = rightOf(leftOf(expr));
    const z = rightOf(expr);
    alteredLast = 1;
    return allocCons(allocCons(x, z), allocCons(y, z));
  }

  /* otherwise recurse left then right */
  let newLeft = _step(leftOf(expr));
  if (alteredLast) return allocCons(newLeft, rightOf(expr));

  let newRight = _step(rightOf(expr));
  if (alteredLast) return allocCons(leftOf(expr), newRight);

  return expr; // unchanged
}

export function reduce(expr: u32, max: u32 = 0xffffffff): u32 {
  let cur: u32 = expr;
  for (let i: u32 = 0; i < max; ++i) {
    cur = arenaKernelStep(cur);
    if (!alteredLast) break;
  }
  return cur;
}
