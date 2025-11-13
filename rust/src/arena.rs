//! Arena-based memory management for SKI expressions
//!
//! This module provides efficient arena-based memory management for SKI expressions,
//! with structural sharing through hash-consing.

/// Arena node kind
#[repr(u8)]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ArenaKind {
    Terminal = 1,
    NonTerm = 2,
}

/// SKI combinator symbols
#[repr(u8)]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ArenaSym {
    S = 1,
    K = 2,
    I = 3,
}

const EMPTY: u32 = 0xffff_ffff;

const INITIAL_CAP: usize = 1 << 20; // ~1,048,576 nodes
const MAX_CAP: usize = 1 << 28; // 268,435,456 nodes

const BUCKET_SHIFT: u32 = 16;
const N_BUCKETS: usize = 1 << BUCKET_SHIFT; // 65,536
const MASK: u32 = (1 << BUCKET_SHIFT) - 1; // 0xffff

/// Global arena state
/// SAFETY: Using static mut is safe in WASM context as it's single-threaded.
/// The warnings are about Rust 2024 edition compatibility, but this pattern
/// is acceptable for single-threaded WASM code.
#[allow(static_mut_refs)]
static mut ARENA: Option<Arena> = None;

struct Arena {
    cap: usize,
    kind: Vec<u8>,
    sym_arr: Vec<u8>,
    left_id: Vec<u32>,
    right_id: Vec<u32>,
    hash32: Vec<u32>,
    next_idx: Vec<u32>,
    buckets: Vec<u32>,
    term_cache: [u32; 4],
    top: usize,
    altered_last: u32,
}

impl Arena {
    fn new() -> Self {
        let cap = INITIAL_CAP;
        Arena {
            cap,
            kind: vec![0; cap],
            sym_arr: vec![0; cap],
            left_id: vec![0; cap],
            right_id: vec![0; cap],
            hash32: vec![0; cap],
            next_idx: vec![0; cap],
            buckets: vec![EMPTY; N_BUCKETS],
            term_cache: [EMPTY; 4],
            top: 0,
            altered_last: 0,
        }
    }

    fn ensure_capacity(&mut self, nodes_needed: usize) {
        if self.top + nodes_needed <= self.cap {
            return;
        }

        if self.cap >= MAX_CAP {
            // Out of memory - panic
            panic!("Arena capacity exceeded");
        }

        let new_cap = (self.cap << 1).min(MAX_CAP);

        self.kind.resize(new_cap, 0);
        self.sym_arr.resize(new_cap, 0);
        self.left_id.resize(new_cap, 0);
        self.right_id.resize(new_cap, 0);
        self.hash32.resize(new_cap, 0);
        self.next_idx.resize(new_cap, 0);

        self.cap = new_cap;
    }

    fn is_terminal(&self, n: u32) -> bool {
        self.kind[n as usize] == ArenaKind::Terminal as u8
    }
}

/// Fast 32-bit integer scrambler with good distribution properties
/// Based on MurmurHash3's finalizer (avalanche function)
fn avalanche32(mut x: u32) -> u32 {
    x ^= x >> 16;
    x = x.wrapping_mul(0x7feb352d);
    x ^= x >> 15;
    x = x.wrapping_mul(0x846ca68b);
    x ^= x >> 16;
    x
}

/// Donald Knuth's multiplicative hash constant
const GOLD: u32 = 0x9e3779b9;

/// Mix two hash values
fn mix(a: u32, b: u32) -> u32 {
    avalanche32(a ^ b.wrapping_mul(GOLD))
}

/// Initialize the arena
/// SAFETY: This is safe in WASM context as it's single-threaded.
#[allow(static_mut_refs)]
fn get_arena() -> &'static mut Arena {
    unsafe {
        if ARENA.is_none() {
            ARENA = Some(Arena::new());
        }
        ARENA.as_mut().unwrap()
    }
}

/// Get the kind of a node
#[no_mangle]
pub extern "C" fn kindOf(n: u32) -> u32 {
    let arena = get_arena();
    if (n as usize) >= arena.kind.len() {
        return 0;
    }
    arena.kind[n as usize] as u32
}

/// Get the symbol of a terminal node
#[no_mangle]
pub extern "C" fn symOf(n: u32) -> u32 {
    let arena = get_arena();
    if (n as usize) >= arena.sym_arr.len() {
        return 0;
    }
    arena.sym_arr[n as usize] as u32
}

/// Get the left child of a node
#[no_mangle]
pub extern "C" fn leftOf(n: u32) -> u32 {
    let arena = get_arena();
    if (n as usize) >= arena.left_id.len() {
        return 0;
    }
    arena.left_id[n as usize]
}

/// Get the right child of a node
#[no_mangle]
pub extern "C" fn rightOf(n: u32) -> u32 {
    let arena = get_arena();
    if (n as usize) >= arena.right_id.len() {
        return 0;
    }
    arena.right_id[n as usize]
}

/// Reset the arena to initial state
#[no_mangle]
pub extern "C" fn reset() {
    let arena = get_arena();
    arena.top = 0;
    arena.buckets.fill(EMPTY);
    arena.term_cache.fill(EMPTY);
}

/// Allocate a terminal node
#[no_mangle]
pub extern "C" fn allocTerminal(s: u32) -> u32 {
    let arena = get_arena();

    // Check cache
    if s < 4 {
        let cached = arena.term_cache[s as usize];
        if cached != EMPTY {
            return cached;
        }
    }

    arena.ensure_capacity(1);
    let id = arena.top as u32;
    arena.top += 1;

    arena.kind[id as usize] = ArenaKind::Terminal as u8;
    arena.sym_arr[id as usize] = s as u8;
    arena.hash32[id as usize] = s;

    if s < 4 {
        arena.term_cache[s as usize] = id;
    }

    id
}

/// Allocate a cons cell (binary node) with hash-consing
#[no_mangle]
pub extern "C" fn allocCons(l: u32, r: u32) -> u32 {
    let arena = get_arena();

    let h = mix(arena.hash32[l as usize], arena.hash32[r as usize]);
    let b = (h & MASK) as usize;

    // Check if this node already exists (hash-consing)
    let mut i = arena.buckets[b];
    while i != EMPTY {
        if arena.hash32[i as usize] == h &&
           arena.left_id[i as usize] == l &&
           arena.right_id[i as usize] == r {
            return i;
        }
        i = arena.next_idx[i as usize];
    }

    // Allocate new node
    arena.ensure_capacity(1);
    let id = arena.top as u32;
    arena.top += 1;

    arena.kind[id as usize] = ArenaKind::NonTerm as u8;
    arena.left_id[id as usize] = l;
    arena.right_id[id as usize] = r;
    arena.hash32[id as usize] = h;
    arena.next_idx[id as usize] = arena.buckets[b];
    arena.buckets[b] = id;

    id
}

/// Perform one step of SKI reduction
fn step_internal(expr: u32) -> u32 {
    let arena = get_arena();

    if arena.is_terminal(expr) {
        return expr;
    }

    let left = arena.left_id[expr as usize];
    let right = arena.right_id[expr as usize];

    // I x ⇒ x
    if arena.is_terminal(left) && arena.sym_arr[left as usize] == ArenaSym::I as u8 {
        arena.altered_last = 1;
        return right;
    }

    // (K x) y ⇒ x
    if !arena.is_terminal(left) {
        let left_left = arena.left_id[left as usize];
        if arena.is_terminal(left_left) && arena.sym_arr[left_left as usize] == ArenaSym::K as u8 {
            arena.altered_last = 1;
            return arena.right_id[left as usize];
        }

        // ((S x) y) z ⇒ (x z) (y z)
        let left_of_left = arena.left_id[left as usize];
        if !arena.is_terminal(left_of_left) {
            let left_left_left = arena.left_id[left_of_left as usize];
            if arena.is_terminal(left_left_left) &&
               arena.sym_arr[left_left_left as usize] == ArenaSym::S as u8 {
                let x = arena.right_id[left_of_left as usize];
                let y = arena.right_id[left as usize];
                let z = right;
                arena.altered_last = 1;

                // Build (x z) (y z)
                let xz = allocCons(x, z);
                let yz = allocCons(y, z);
                return allocCons(xz, yz);
            }
        }
    }

    // Recurse left
    let new_left = step_internal(left);
    if arena.altered_last != 0 {
        return allocCons(new_left, right);
    }

    // Recurse right
    let new_right = step_internal(right);
    if arena.altered_last != 0 {
        return allocCons(left, new_right);
    }

    expr
}

/// Perform a single step in the evaluation of an SKI expression
#[no_mangle]
pub extern "C" fn arenaKernelStep(expr: u32) -> u32 {
    let arena = get_arena();
    arena.altered_last = 0;
    step_internal(expr)
}

/// Reduce an SKI expression to normal form
#[no_mangle]
pub extern "C" fn reduce(expr: u32, max: u32) -> u32 {
    let mut cur = expr;
    let limit = if max == 0xffffffff { u32::MAX } else { max };

    for _ in 0..limit {
        cur = arenaKernelStep(cur);
        let arena = get_arena();
        if arena.altered_last == 0 {
            break;
        }
    }

    cur
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup() {
        reset();
    }

    #[test]
    fn test_alloc_terminal() {
        setup();

        let s = allocTerminal(ArenaSym::S as u32);
        let k = allocTerminal(ArenaSym::K as u32);
        let i = allocTerminal(ArenaSym::I as u32);

        assert_eq!(kindOf(s), ArenaKind::Terminal as u32);
        assert_eq!(symOf(s), ArenaSym::S as u32);
        assert_eq!(symOf(k), ArenaSym::K as u32);
        assert_eq!(symOf(i), ArenaSym::I as u32);
    }

    #[test]
    fn test_terminal_caching() {
        setup();

        let s1 = allocTerminal(ArenaSym::S as u32);
        let s2 = allocTerminal(ArenaSym::S as u32);

        // Should return the same node due to caching
        assert_eq!(s1, s2);
    }

    #[test]
    fn test_alloc_cons() {
        setup();

        let s = allocTerminal(ArenaSym::S as u32);
        let k = allocTerminal(ArenaSym::K as u32);
        let cons = allocCons(s, k);

        assert_eq!(kindOf(cons), ArenaKind::NonTerm as u32);
        assert_eq!(leftOf(cons), s);
        assert_eq!(rightOf(cons), k);
    }

    #[test]
    fn test_cons_hash_consing() {
        setup();

        let s = allocTerminal(ArenaSym::S as u32);
        let k = allocTerminal(ArenaSym::K as u32);

        let cons1 = allocCons(s, k);
        let cons2 = allocCons(s, k);

        // Should return the same node due to hash-consing
        assert_eq!(cons1, cons2);
    }

    #[test]
    fn test_i_combinator() {
        setup();

        // I x => x
        let i = allocTerminal(ArenaSym::I as u32);
        let x = allocTerminal(ArenaSym::S as u32);
        let expr = allocCons(i, x);

        let result = arenaKernelStep(expr);

        // I x should reduce to x
        assert_eq!(result, x);
        assert_eq!(kindOf(result), ArenaKind::Terminal as u32);
        assert_eq!(symOf(result), ArenaSym::S as u32);
    }

    #[test]
    fn test_k_combinator() {
        setup();

        // (K x) y => x
        let k = allocTerminal(ArenaSym::K as u32);
        let x = allocTerminal(ArenaSym::S as u32);
        let y = allocTerminal(ArenaSym::I as u32);

        let kx = allocCons(k, x);
        let expr = allocCons(kx, y);

        let result = arenaKernelStep(expr);

        // (K x) y should reduce to x
        assert_eq!(result, x);
        assert_eq!(kindOf(result), ArenaKind::Terminal as u32);
        assert_eq!(symOf(result), ArenaSym::S as u32);
    }

    #[test]
    fn test_s_combinator() {
        setup();

        // ((S x) y) z => (x z) (y z)
        let s = allocTerminal(ArenaSym::S as u32);
        let x = allocTerminal(ArenaSym::K as u32);
        let y = allocTerminal(ArenaSym::I as u32);
        let z = allocTerminal(10); // Some arbitrary symbol

        let sx = allocCons(s, x);
        let sxy = allocCons(sx, y);
        let expr = allocCons(sxy, z);

        let result = arenaKernelStep(expr);

        // Should be a cons cell: (x z) (y z)
        assert_eq!(kindOf(result), ArenaKind::NonTerm as u32);

        let left = leftOf(result);
        let right = rightOf(result);

        // left should be (x z)
        assert_eq!(kindOf(left), ArenaKind::NonTerm as u32);
        assert_eq!(leftOf(left), x);
        assert_eq!(rightOf(left), z);

        // right should be (y z)
        assert_eq!(kindOf(right), ArenaKind::NonTerm as u32);
        assert_eq!(leftOf(right), y);
        assert_eq!(rightOf(right), z);
    }

    #[test]
    fn test_reduce_i() {
        setup();

        // I x => x (should reduce in one step)
        let i = allocTerminal(ArenaSym::I as u32);
        let x = allocTerminal(ArenaSym::S as u32);
        let expr = allocCons(i, x);

        let result = reduce(expr, 100);

        assert_eq!(result, x);
    }

    #[test]
    fn test_reduce_k() {
        setup();

        // (K x) y => x
        let k = allocTerminal(ArenaSym::K as u32);
        let x = allocTerminal(ArenaSym::S as u32);
        let y = allocTerminal(ArenaSym::I as u32);

        let kx = allocCons(k, x);
        let expr = allocCons(kx, y);

        let result = reduce(expr, 100);

        assert_eq!(result, x);
    }

    #[test]
    fn test_reduce_nested() {
        setup();

        // I (K x) => K x
        let i = allocTerminal(ArenaSym::I as u32);
        let k = allocTerminal(ArenaSym::K as u32);
        let x = allocTerminal(ArenaSym::S as u32);

        let kx = allocCons(k, x);
        let expr = allocCons(i, kx);

        let result = reduce(expr, 100);

        // I (K x) => (K x)
        assert_eq!(result, kx);
        assert_eq!(leftOf(result), k);
        assert_eq!(rightOf(result), x);
    }

    #[test]
    fn test_reset() {
        setup();

        let s1 = allocTerminal(ArenaSym::S as u32);
        let k1 = allocTerminal(ArenaSym::K as u32);
        let _cons1 = allocCons(s1, k1);

        // Reset and allocate again
        reset();

        let s2 = allocTerminal(ArenaSym::S as u32);
        let k2 = allocTerminal(ArenaSym::K as u32);

        // After reset, nodes should start from 0 again
        // (s2 should be 0 since S is cached and reset clears cache)
        assert_eq!(s2, 0);
        assert_eq!(k2, 1);
    }

    #[test]
    fn test_terminal_accessors() {
        setup();

        let s = allocTerminal(ArenaSym::S as u32);
        let k = allocTerminal(ArenaSym::K as u32);
        let i = allocTerminal(ArenaSym::I as u32);

        assert_eq!(kindOf(s), ArenaKind::Terminal as u32);
        assert_eq!(kindOf(k), ArenaKind::Terminal as u32);
        assert_eq!(kindOf(i), ArenaKind::Terminal as u32);

        assert_eq!(symOf(s), ArenaSym::S as u32);
        assert_eq!(symOf(k), ArenaSym::K as u32);
        assert_eq!(symOf(i), ArenaSym::I as u32);
    }

    #[test]
    fn test_cons_accessors() {
        setup();

        let s = allocTerminal(ArenaSym::S as u32);
        let k = allocTerminal(ArenaSym::K as u32);
        let i = allocTerminal(ArenaSym::I as u32);

        let sk = allocCons(s, k);
        let ski = allocCons(sk, i);

        assert_eq!(kindOf(ski), ArenaKind::NonTerm as u32);
        assert_eq!(leftOf(ski), sk);
        assert_eq!(rightOf(ski), i);
        assert_eq!(leftOf(leftOf(ski)), s);
        assert_eq!(rightOf(leftOf(ski)), k);
    }
}

