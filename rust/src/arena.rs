//! # Arena-Based Memory Management for SKI Expressions (WASM, no_std)
//!
//! This module implements a high-performance, thread-safe arena allocator optimized
//! for SKI combinator calculus evaluation. It supports both single-threaded heap-based
//! allocation and multi-threaded SharedArrayBuffer (SAB) based allocation for Web Workers.
//!
//! ## Core Architecture
//!
//! ### Arena Node Types
//!
//! The arena uses four distinct node types to represent SKI expressions and evaluation state:
//!
//! - **`Terminal`**: Leaf nodes containing SKI combinators (S, K, I)
//!   - `kind = 1`, `sym` contains the combinator symbol
//!
//! - **`NonTerm`**: Application nodes (function application)
//!   - `kind = 2`, `left` and `right` point to subexpressions
//!   - Represents expressions of the form `(left right)`
//!
//! - **`Continuation`**: Stack frames for iterative reduction (optimization)
//!   - `kind = 3`, `sym` indicates reduction stage, `left`/`right` point to parent stack and node
//!   - Used by the iterative reduction algorithm to avoid recursion stack overflow
//!
//! - **`Suspension`**: Paused evaluation state for preemptive multitasking
//!   - `kind = 4`, `sym` contains evaluation mode, `left`/`right` contain current expression and stack
//!   - `hash` field stores remaining reduction steps for resumption
//!   - Enables cooperative multitasking across Web Workers
//!
//! ### Memory Layout (SharedArrayBuffer Mode)
//!
//! ```text
//! +-------------------+ <-- ARENA_BASE_ADDR
//! | SabHeader         |
//! | - Magic, offsets  |
//! | - Rings, capacity |
//! | - Atomic counters |
//! +-------------------+ <-- offset_sq (64-byte aligned)
//! | Submission Ring   |
//! | (1024 entries)    |
//! +-------------------+ <-- offset_cq (64-byte aligned)
//! | Completion Ring   |
//! | (1024 entries)    |
//! +-------------------+ <-- offset_kind (64-byte aligned)
//! | Kind Array        |  u8[capacity] - Node types
//! +-------------------+ <-- offset_sym
//! | Sym Array         |  u8[capacity] - Symbols/modes
//! +-------------------+ <-- offset_left_id (64-byte aligned)
//! | Left Array        | u32[capacity] - Left child pointers
//! +-------------------+ <-- offset_right_id
//! | Right Array       | u32[capacity] - Right child pointers
//! +-------------------+ <-- offset_hash32
//! | Hash Array        | u32[capacity] - Hash values for deduplication
//! +-------------------+ <-- offset_next_idx
//! | Next Array        | u32[capacity] - Hash table collision chains
//! +-------------------+ <-- offset_buckets (64-byte aligned)
//! | Bucket Array      | u32[capacity] - Hash table buckets
//! +-------------------+ <-- offset_term_cache
//! | Terminal Cache    | u32[4] - Cached S/K/I node IDs
//! +-------------------+ <-- End of arena
//! ```
//!
//! ### Key Optimizations
//!
//! #### 1. Hash-Consing (Structural Sharing)
//!
//! - **[Hash consing](https://en.wikipedia.org/wiki/Hash_consing)** dedupes identical subexpressions to prevent redundant allocations
//! - **Uses avalanche hash** of `(left, right)` pairs for fast lookups
//! - **Collision resolution** via separate chaining in the bucket array
//! - **Memory efficiency**: [DAG](https://en.wikipedia.org/wiki/Directed_acyclic_graph) representation instead of tree
//!
//! #### 2. Iterative Reduction with Continuations
//!
//! - **Avoids recursion stack overflow** on deep expressions
//! - **Continuation nodes** represent suspended stack frames
//! - **Two-stage reduction**: left child first, then right child
//! - **Memory reuse**: Dead continuation frames are recycled
//!
//! #### 3. Preemptive Multitasking (Suspensions)
//!
//! - **Cooperative yielding** when traversal gas is exhausted
//! - **Suspension nodes** capture complete evaluation state
//! - **Worker preemption** prevents starvation in parallel evaluation
//! - **State resumption** via suspension node deserialization
//!
//! #### 4. Lock-Free Ring Buffers (io_uring Style)
//!
//! - **Submission Queue (SQ)**: Main thread → Worker communication
//! - **Completion Queue (CQ)**: Worker → Main thread results
//! - **Atomic operations** for thread-safe producer/consumer patterns
//! - **Blocking waits** using WASM atomic wait/notify
//!
//! #### 5. Concurrent Resizing
//!
//! - **[Seqlock](https://en.wikipedia.org/wiki/Seqlock)-style synchronization** for arena growth
//! - **Stop-the-world pauses** during resize operations
//! - **Reverse-order copying** to handle overlapping memory regions
//! - **Poisoning** on OOM to prevent infinite waits
//!
//! ### Performance Characteristics
//!
//! - **O(1) allocation** for new nodes (amortized)
//! - **O(1) lookup** for existing subexpressions (hash-consing)
//! - **O(depth) reduction** with iterative algorithm (no stack overflow)
//! - **Lock-free communication** between main thread and workers
//! - **Memory efficient**: ~16 bytes per node, structural sharing
//!
//! ### Thread Safety
//!
//! - **Atomic operations** for all shared state access
//! - **Seqlock** for resize synchronization
//! - **Separate arenas** per worker (no cross-worker sharing)
//! - **Ring buffer fences** prevent data races in communication
//!
//! ### Integration with JavaScript
//!
//! - **[SharedArrayBuffer](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/SharedArrayBuffer)** enables cross-thread memory access
//! - **Cross-origin isolation** required for SAB support
//! - **Typed array views** provide efficient memory access from JS
//! - **Ring polling** in main thread for completion handling

#![allow(dead_code)]

// =============================================================================
// Public enums (shared with JS)
// =============================================================================

/// Arena node types supporting SKI evaluation and parallel execution.
///
/// See module-level documentation for detailed descriptions of each variant.
#[repr(u8)]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ArenaKind {
    /// Terminal node containing an SKI combinator (S, K, or I).
    /// - `sym`: The combinator symbol
    /// - `left`/`right`: Unused (reserved)
    Terminal = 1,

    /// Application node representing function application `(left right)`.
    /// - `left`: Function expression
    /// - `right`: Argument expression
    /// - `sym`: Unused (reserved)
    NonTerm = 2,

    /// Stack frame for iterative reduction algorithm.
    /// Used to avoid recursion stack overflow on deep expressions.
    /// - `sym`: Reduction stage (0=left child, 1=right child)
    /// - `left`: Parent stack frame
    /// - `right`: Parent expression node
    Continuation = 3,

    /// Paused evaluation state for preemptive multitasking.
    /// Captures complete evaluation context for resumption.
    /// - `sym`: Evaluation mode (0=descend, 1=return)
    /// - `left`: Current expression being evaluated
    /// - `right`: Evaluation stack
    /// - `hash`: Remaining reduction steps
    Suspension = 4,
}

/// SKI combinator symbols and evaluation state markers.
///
/// Used in both Terminal nodes (for combinators) and Continuation/Suspension
/// nodes (for evaluation state).
#[repr(u8)]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ArenaSym {
    /// S combinator: `S x y z → x z (y z)`
    /// The most complex combinator, enabling arbitrary computation.
    S = 1,

    /// K combinator: `K x y → x`
    /// The constant function, discards its second argument.
    K = 2,

    /// I combinator: `I x → x`
    /// The identity function, returns its argument unchanged.
    I = 3,
}

// =============================================================================
// Non-WASM stubs (keep TS type-checking happy)
// =============================================================================
#[cfg(not(target_arch = "wasm32"))]
#[no_mangle]
pub extern "C" fn initArena(_cap: u32) -> u32 { 0 }
#[cfg(not(target_arch = "wasm32"))]
#[no_mangle]
pub extern "C" fn connectArena(_p: u32) -> u32 { 0 }
#[cfg(not(target_arch = "wasm32"))]
#[no_mangle]
pub extern "C" fn allocTerminal(_s: u32) -> u32 { 0 }
#[cfg(not(target_arch = "wasm32"))]
#[no_mangle]
pub extern "C" fn allocCons(_l: u32, _r: u32) -> u32 { 0 }
#[cfg(not(target_arch = "wasm32"))]
#[no_mangle]
pub extern "C" fn kindOf(_n: u32) -> u32 { 0 }
#[cfg(not(target_arch = "wasm32"))]
#[no_mangle]
pub extern "C" fn symOf(_n: u32) -> u32 { 0 }
#[cfg(not(target_arch = "wasm32"))]
#[no_mangle]
pub extern "C" fn leftOf(_n: u32) -> u32 { 0 }
#[cfg(not(target_arch = "wasm32"))]
#[no_mangle]
pub extern "C" fn rightOf(_n: u32) -> u32 { 0 }
#[cfg(not(target_arch = "wasm32"))]
#[no_mangle]
pub extern "C" fn reset() {}
#[cfg(not(target_arch = "wasm32"))]
#[no_mangle]
pub extern "C" fn arenaKernelStep(x: u32) -> u32 { x }
#[cfg(not(target_arch = "wasm32"))]
#[no_mangle]
pub extern "C" fn hostSubmit(_id: u32) -> u32 { 1 }
#[cfg(not(target_arch = "wasm32"))]
#[no_mangle]
pub extern "C" fn hostPull() -> u32 { u32::MAX }
#[cfg(not(target_arch = "wasm32"))]
#[no_mangle]
pub extern "C" fn workerLoop() {}
#[cfg(not(target_arch = "wasm32"))]
#[no_mangle]
pub extern "C" fn debugGetArenaBaseAddr() -> u32 { 0 }
#[cfg(not(target_arch = "wasm32"))]
#[no_mangle]
pub extern "C" fn getArenaMode() -> u32 { 0 }
#[cfg(not(target_arch = "wasm32"))]
#[no_mangle]
pub extern "C" fn debugCalculateArenaSize(_c: u32) -> u32 { 0 }
#[cfg(not(target_arch = "wasm32"))]
#[no_mangle]
pub extern "C" fn debugLockState() -> u32 { 0xffff_ffff }

// =============================================================================
// WASM implementation
// =============================================================================
#[cfg(target_arch = "wasm32")]
mod wasm {
    use core::arch::wasm32;
    use core::cell::UnsafeCell;
    use core::sync::atomic::{AtomicU32, AtomicU8, Ordering};
    use crate::{ArenaKind, ArenaSym};

    // -------------------------------------------------------------------------
    // Constants / helpers
    // -------------------------------------------------------------------------
    pub const EMPTY: u32 = 0xffff_ffff;
    const ARENA_MAGIC: u32 = 0x534B_4941; // "SKIA"
    const INITIAL_CAP: u32 = 1 << 20;
    const MAX_CAP: u32 = 1 << 27;
    const WASM_PAGE_SIZE: usize = 65536;
    const RING_ENTRIES: u32 = 1024; // power of two

    #[inline(always)]
    const fn align64(x: u32) -> u32 {
        (x + 63) & !63
    }

    // -------------------------------------------------------------------------
    // Atomics + wait/notify
    // -------------------------------------------------------------------------
    // WASM atomics / CAS safety notes (applies to all compare_exchange* uses below)
    // -------------------------------------------------------------------------
    //
    // This module relies heavily on CAS (compare_exchange / compare_exchange_weak),
    // which compiles to a single atomic read-modify-write instruction in WebAssembly
    // (e.g. `i32.atomic.rmw.cmpxchg`). That property prevents the classic "check-then-
    // store" race where two threads both observe a value and both write the same
    // update thinking they won; CAS has a single winner and forces losers to retry.
    //
    // ABA notes:
    // - Many CAS patterns are vulnerable to ABA when the *same* value can reappear
    //   (e.g. counters wrapping or pointer reuse). In this codebase, ABA is either
    //   explicitly prevented (ring slot sequence numbers advance by whole cycles)
    //   or is practically irrelevant in context (e.g. seqlock-style counters would
    //   require billions of expensive operations to wrap during one read section).
    //
    // WASM platform particularities:
    // - When wasm threads are enabled, the linear memory is backed by a
    //   `SharedArrayBuffer`, and atomic ops synchronize across Web Workers.
    //   Rust `Ordering::{Acquire,Release,AcqRel,SeqCst}` map onto WASM atomics/fences
    //   to provide the needed visibility guarantees.
    // - `memory.grow` increases linear memory size but does not "move" addresses
    //   from the module's perspective; what changes is our chosen layout within
    //   that address space (offsets/capacity), guarded by atomics/seqlock.
    //
    // External references:
    // - Seqlock concept: https://en.wikipedia.org/wiki/Seqlock
    // - SharedArrayBuffer (required for wasm threads): https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/SharedArrayBuffer
    // - WebAssembly features (threads/atomics): https://webassembly.org/features/
    // - Rust atomic memory orderings: https://doc.rust-lang.org/std/sync/atomic/enum.Ordering.html
    // - WebAssembly `memory.grow`: https://developer.mozilla.org/en-US/docs/WebAssembly/Reference/Memory/Grow
    //
    mod sys {
        use super::*;
        #[inline(always)]
        pub fn wait32(ptr: &AtomicU32, expected: u32) {
            unsafe {
                let _ = wasm32::memory_atomic_wait32(
                    ptr as *const _ as *mut i32,
                    expected as i32,
                    -1,
                );
            }
        }
        #[inline(always)]
        pub fn notify(ptr: &AtomicU32, count: u32) {
            unsafe {
                let _ = wasm32::memory_atomic_notify(ptr as *const _ as *mut i32, count);
            }
        }
    }

    // -------------------------------------------------------------------------
    // Ring Buffer Types (io_uring Style)
    // -------------------------------------------------------------------------

    /// Submission Queue Entry: Main thread → Worker communication.
    ///
    /// Sent from main thread to worker to request evaluation of an expression.
    /// Workers dequeue these and perform the actual reduction work.
    #[repr(C)]
    #[derive(Clone, Copy)]
    pub struct Sqe {
        /// Arena node ID of the expression to evaluate.
        /// This is the root of the expression tree to reduce.
        pub node_id: u32,

        /// Unique request identifier for correlation.
        /// Used to match completion queue entries back to the original request.
        /// Must be unique across all outstanding requests.
        pub req_id: u32,

        /// Max reduction steps for this specific request.
        /// Replaces previous _pad field. Each request carries its own immutable limit.
        pub max_steps: u32,
    }

    /// Completion Queue Entry: Worker → Main thread results.
    ///
    /// Workers enqueue these when they complete (or yield) evaluation work.
    /// The main thread polls the completion queue to retrieve results.
    #[repr(C)]
    #[derive(Clone, Copy)]
    pub struct Cqe {
        /// Result node ID or Suspension node ID (for yields).
        /// - If reduction completed: The fully reduced expression node
        /// - If evaluation yielded: A Suspension node for resumption
        pub node_id: u32,

        /// Request identifier matching the original Sqe.req_id.
        /// Used by main thread to correlate completions with pending requests.
        pub req_id: u32,

        /// Padding to align Slot<Cqe> to 16 bytes (power of 2) for efficient indexing.
        pub _pad: u32,
    }

    /// Ring buffer slot with sequence number for ABA prevention.
    ///
    /// Each slot contains a sequence number and payload. The sequence number
    /// prevents ABA problems in concurrent CAS operations by ensuring that
    /// a slot can only be reused after a full cycle of the ring.
    ///
    /// ## Sequence Number Protocol
    ///
    /// - **Initial state**: `seq = slot_index`
    /// - **Producer stores**: `seq = tail + 1`, payload written, `seq = tail + 1` (final)
    /// - **Consumer loads**: Checks `seq == head + 1`, payload read, `seq = head + mask + 1`
    ///
    /// This ensures proper ordering and prevents race conditions.
    #[repr(C)]
    struct Slot<T> {
        /// Sequence number for synchronization and ABA prevention.
        /// Must be atomically updated to maintain memory ordering.
        seq: AtomicU32,

        /// The actual data payload stored in this slot.
        /// Access must be synchronized with sequence number updates.
        payload: UnsafeCell<T>,
    }

    // SAFETY: Ring<T> ensures proper synchronization of Slot<T> access.
    // The UnsafeCell is only accessed after proper sequence number validation.
    unsafe impl<T> Sync for Slot<T> {}

    /// Lock-free, wait-free ring buffer for inter-thread communication.
    ///
    /// Uses [io_uring](https://en.wikipedia.org/wiki/Io_uring)-style producer/consumer pattern with atomic operations.
    /// Supports both non-blocking (try_*) and blocking (*_blocking) operations.
    ///
    /// ## Design Principles
    ///
    /// - **Single-producer, single-consumer** per ring instance
    /// - **Power-of-two sizing** for efficient masking operations
    /// - **Cache-line alignment** (64-byte) to prevent false sharing
    /// - **Atomic wait/notify** for efficient blocking operations
    /// - **Sequence numbers** prevent ABA problems in concurrent access
    ///
    /// ## Memory Layout
    ///
    /// ```text
    /// +----------------------+ <-- 64-byte aligned
    /// | head: AtomicU32      |     Consumer position
    /// | not_full: AtomicU32  |     Wait/notify for producers
    /// | _pad1: [u8; 56]      |     Cache line padding
    /// +----------------------+ <-- 64-byte aligned
    /// | tail: AtomicU32      |     Producer position
    /// | not_empty: AtomicU32 |     Wait/notify for consumers
    /// | _pad2: [u8; 56]      |     Cache line padding
    /// +----------------------+
    /// | mask: u32            |     entries - 1 (for fast modulo)
    /// | entries: u32         |     Ring capacity (power of 2)
    /// +----------------------+
    /// | slots[entries]       |     Array of Slot<T> entries
    /// +----------------------+
    /// ```
    ///
    /// ## Thread Safety
    ///
    /// - **Producer calls**: `try_enqueue()`, `enqueue_blocking()`
    /// - **Consumer calls**: `try_dequeue()`, `dequeue_blocking()`
    /// - **No internal locking**: Uses atomic CAS operations only
    /// - **Wait-free progress**: No thread can be indefinitely blocked
    #[repr(C, align(64))]
    pub struct Ring<T> {
        /// Consumer position (head of queue).
        /// Only modified by consumer thread via CAS.
        head: AtomicU32,

        /// Producer wait/notify synchronization.
        /// Used by producers to wait when ring is full.
        not_full: AtomicU32,

        /// Cache line padding to prevent false sharing with tail.
        _pad1: [u8; 56],

        /// Producer position (tail of queue).
        /// Only modified by producer thread via CAS.
        tail: AtomicU32,

        /// Consumer wait/notify synchronization.
        /// Used by consumers to wait when ring is empty.
        not_empty: AtomicU32,

        /// Cache line padding to prevent false sharing with head.
        _pad2: [u8; 56],

        /// Bitmask for fast modulo: `index & mask` ≡ `index % entries`
        mask: u32,

        /// Ring capacity (must be power of 2).
        entries: u32,

        /// Zero-sized type marker for generic parameter.
        _marker: core::marker::PhantomData<T>,
    }

    impl<T: Copy> Ring<T> {
        /// Get pointer to the slots array following the Ring header.
        #[inline(always)]
        fn slots_ptr(&self) -> *const Slot<T> {
            unsafe { (self as *const Ring<T>).add(1) as *const Slot<T> }
        }

        /// Get reference to slot at the given index (masked for wraparound).
        #[inline(always)]
        unsafe fn slot_at(&self, i: u32) -> &Slot<T> {
            &*self.slots_ptr().add((i & self.mask) as usize)
        }

        /// Initialize a ring buffer at the given memory location.
        ///
        /// # Safety
        ///
        /// - `ptr` must point to sufficient memory for the ring and all slots
        /// - `entries_pow2` must be a power of 2
        /// - The ring must not be accessed concurrently during initialization
        #[inline(always)]
        pub unsafe fn init_at(ptr: *mut u8, entries_pow2: u32) -> &'static Self {
            let ring = &mut *(ptr as *mut Ring<T>);
            // Initialize producer/consumer positions
            ring.head.store(0, Ordering::Relaxed);
            ring.tail.store(0, Ordering::Relaxed);
            // Initialize wait/notify counters
            ring.not_empty.store(0, Ordering::Relaxed);
            ring.not_full.store(0, Ordering::Relaxed);
            // Set ring parameters
            ring.entries = entries_pow2;
            ring.mask = entries_pow2 - 1;
            // Initialize slot sequence numbers to their indices
            for i in 0..entries_pow2 {
                ring.slot_at(i).seq.store(i, Ordering::Relaxed);
            }
            ring
        }

        /// Attempt to enqueue an item without blocking.
        ///
        /// Returns `true` if the item was successfully enqueued, `false` if the ring is full.
        ///
        /// ## Algorithm
        ///
        /// 1. Load current tail position
        /// 2. Check if the corresponding slot is available (`seq == tail`)
        /// 3. Attempt to claim the slot by CAS'ing tail forward
        /// 4. If successful: write payload, update sequence, notify consumers
        /// 5. If slot unavailable: check if ring is full or retry
        ///
        /// ## Memory Ordering
        ///
        /// - `Acquire` load of sequence number ensures payload visibility
        /// - `Release` store of sequence number publishes payload to consumers
        /// - `Release` notify ensures consumer sees all prior writes
        ///
        /// See [memory barriers](https://en.wikipedia.org/wiki/Memory_barrier) for details.
        #[inline(always)]
        pub fn try_enqueue(&self, item: T) -> bool {
            unsafe {
                loop {
                    // Load producer position (relaxed: no ordering requirements)
                    let t = self.tail.load(Ordering::Relaxed);
                    let slot = self.slot_at(t);

                    // Check if slot is available for us (Acquire: see previous publications)
                    let s = slot.seq.load(Ordering::Acquire);
                    let diff = s.wrapping_sub(t);

                    if diff == 0 {
                        // Slot is free. Try to claim it by advancing tail.
                        // See "WASM atomics / CAS safety notes" above (cmpxchg winner/loser).
                        if self
                            .tail
                            .compare_exchange_weak(
                                t,
                                t.wrapping_add(1),
                                Ordering::Relaxed, // Success: no special ordering
                                Ordering::Relaxed, // Failure: no special ordering
                            )
                            .is_ok()
                        {
                            // Successfully claimed slot. Write payload and publish.
                            *slot.payload.get() = item;
                            slot.seq.store(t.wrapping_add(1), Ordering::Release);
                            // Notify waiting consumers (Release: publish all prior writes)
                            self.not_empty.fetch_add(1, Ordering::Release);
                            sys::notify(&self.not_empty, 1);
                            return true;
                        }
                        // CAS failed: another producer claimed it, retry
                    } else if (diff as i32) < 0 {
                        // Ring is full: slot sequence is too far ahead
                        return false;
                    }
                    // Slot not ready yet, retry (another iteration in progress)
                }
            }
        }

        /// Attempt to dequeue an item without blocking.
        ///
        /// Returns `Some(item)` if an item was successfully dequeued, `None` if the ring is empty.
        ///
        /// ## Algorithm
        ///
        /// 1. Load current head position
        /// 2. Check if the corresponding slot has data (`seq == head + 1`)
        /// 3. Attempt to claim the slot by CAS'ing head forward
        /// 4. If successful: read payload, update sequence for reuse, notify producers
        /// 5. If slot unavailable: check if ring is empty or retry
        ///
        /// ## Sequence Number Reuse
        ///
        /// After consuming, sequence is set to `head + mask + 1`. Since `mask = entries - 1`,
        /// this ensures the slot won't be reused until after a full ring cycle, preventing ABA.
        #[inline(always)]
        pub fn try_dequeue(&self) -> Option<T> {
            unsafe {
                loop {
                    // Load consumer position (relaxed: no ordering requirements)
                    let h = self.head.load(Ordering::Relaxed);
                    let slot = self.slot_at(h);

                    // Check if slot has data for us (Acquire: see producer's publication)
                    let s = slot.seq.load(Ordering::Acquire);
                    let diff = s.wrapping_sub(h.wrapping_add(1));

                    if diff == 0 {
                        // Slot has data. Try to claim it by advancing head.
                        // See "WASM atomics / CAS safety notes" above (cmpxchg winner/loser).
                        if self
                            .head
                            .compare_exchange_weak(
                                h,
                                h.wrapping_add(1),
                                Ordering::Relaxed, // Success: no special ordering
                                Ordering::Relaxed, // Failure: no special ordering
                            )
                            .is_ok()
                        {
                            // Successfully claimed slot. Read payload and release for reuse.
                            let item = *slot.payload.get();
                            // Set sequence for next cycle: h + mask + 1 prevents ABA issues
                            slot.seq
                                .store(h.wrapping_add(self.mask).wrapping_add(1), Ordering::Release);
                            // Notify waiting producers (Release: publish slot availability)
                            self.not_full.fetch_add(1, Ordering::Release);
                            sys::notify(&self.not_full, 1);
                            return Some(item);
                        }
                        // CAS failed: another consumer claimed it, retry
                    } else if (diff as i32) < 0 {
                        // Ring is empty: no data available
                        return None;
                    }
                    // Slot not ready yet, retry (another operation in progress)
                }
            }
        }

        /// Enqueue an item, blocking until space is available.
        ///
        /// Uses WASM atomic wait/notify for efficient blocking when the ring is full.
        /// The wait is interruptible and will retry the enqueue operation.
        #[inline(always)]
        pub fn enqueue_blocking(&self, item: T) {
            while !self.try_enqueue(item) {
                // Load current state and wait for notification
                let v = self.not_full.load(Ordering::Acquire);
                // Double-check after loading (spurious wakeup protection)
                if self.try_enqueue(item) {
                    return;
                }
                // Wait for producer to notify us of available space
                sys::wait32(&self.not_full, v);
            }
        }

        /// Dequeue an item, blocking until data is available.
        ///
        /// Uses WASM atomic wait/notify for efficient blocking when the ring is empty.
        /// The wait is interruptible and will retry the dequeue operation.
        #[inline(always)]
        pub fn dequeue_blocking(&self) -> T {
            loop {
                if let Some(x) = self.try_dequeue() {
                    return x;
                }
                // Load current state and wait for notification
                let v = self.not_empty.load(Ordering::Acquire);
                // Double-check after loading (spurious wakeup protection)
                if let Some(x) = self.try_dequeue() {
                    return x;
                }
                // Wait for consumer to notify us of available data
                sys::wait32(&self.not_empty, v);
            }
        }
    }

    #[inline(always)]
    const fn ring_bytes<T>(entries: u32) -> u32 {
        let header = core::mem::size_of::<Ring<T>>() as u32;
        let slot = core::mem::size_of::<Slot<T>>() as u32;
        align64(header + entries * slot)
    }

    // -------------------------------------------------------------------------
    // Header layout (fixed offsets)
    // -------------------------------------------------------------------------
    #[repr(C, align(64))]
    struct SabHeader {
        magic: u32,
        ring_entries: u32,
        ring_mask: u32,
        offset_sq: u32,
        offset_cq: u32,
        offset_kind: u32,
        offset_sym: u32,
        offset_left_id: u32,
        offset_right_id: u32,
        offset_hash32: u32,
        offset_next_idx: u32,
        offset_buckets: u32,
        offset_term_cache: u32,
        capacity: u32,
        bucket_mask: u32,
        resize_seq: AtomicU32,
        top: AtomicU32,
    }

    impl SabHeader {
        fn layout(capacity: u32) -> (u32, u32, u32) {
            let header_size = core::mem::size_of::<SabHeader>() as u32;
            let offset_sq = align64(header_size);
            let offset_cq = align64(offset_sq + ring_bytes::<Sqe>(RING_ENTRIES));

            let offset_kind = align64(offset_cq + ring_bytes::<Cqe>(RING_ENTRIES));
            let offset_sym = offset_kind + capacity;
            let offset_left_id = align64(offset_sym + capacity);
            let offset_right_id = offset_left_id + 4 * capacity;
            let offset_hash32 = offset_right_id + 4 * capacity;
            let offset_next_idx = offset_hash32 + 4 * capacity;
            let offset_buckets = align64(offset_next_idx + 4 * capacity);
            let offset_term_cache = offset_buckets + 4 * capacity;
            let total_size = offset_term_cache + 16;
            (
                offset_sq,
                offset_cq,
                total_size,
            )
        }
    }

    // -------------------------------------------------------------------------
    // Globals
    // -------------------------------------------------------------------------
    static mut ARENA_BASE_ADDR: u32 = 0;
    static mut ARENA_MODE: u32 = 0;

    #[inline(always)]
    unsafe fn ensure_arena() {
        if ARENA_BASE_ADDR != 0 {
            return;
        }
        // If we were supposed to be in SAB mode but have no base, that's fatal.
        if ARENA_MODE == 1 {
            wasm32::unreachable();
        }
        let ptr = allocate_raw_arena(INITIAL_CAP);
        if ptr.is_null() {
            wasm32::unreachable();
        }
        // Heap / single-instance mode
        ARENA_MODE = 0;
    }

    // -------------------------------------------------------------------------
    // Helpers to locate structures
    // -------------------------------------------------------------------------
    #[inline(always)]
    unsafe fn header() -> &'static SabHeader {
        &*(ARENA_BASE_ADDR as *const SabHeader)
    }

    #[inline(always)]
    unsafe fn header_mut() -> &'static mut SabHeader {
        &mut *(ARENA_BASE_ADDR as *mut SabHeader)
    }

    #[inline(always)]
    unsafe fn sq_ring() -> &'static Ring<Sqe> {
        let h = header();
        &*((ARENA_BASE_ADDR + h.offset_sq) as *const Ring<Sqe>)
    }

    #[inline(always)]
    unsafe fn cq_ring() -> &'static Ring<Cqe> {
        let h = header();
        &*((ARENA_BASE_ADDR + h.offset_cq) as *const Ring<Cqe>)
    }

    // Array helpers
    #[inline(always)]
    unsafe fn kind_ptr() -> *mut AtomicU8 {
        (ARENA_BASE_ADDR + header().offset_kind) as *mut AtomicU8
    }
    #[inline(always)]
    unsafe fn sym_ptr() -> *mut AtomicU8 {
        (ARENA_BASE_ADDR + header().offset_sym) as *mut AtomicU8
    }
    #[inline(always)]
    unsafe fn left_ptr() -> *mut AtomicU32 {
        (ARENA_BASE_ADDR + header().offset_left_id) as *mut AtomicU32
    }
    #[inline(always)]
    unsafe fn right_ptr() -> *mut AtomicU32 {
        (ARENA_BASE_ADDR + header().offset_right_id) as *mut AtomicU32
    }
    #[inline(always)]
    unsafe fn hash_ptr() -> *mut AtomicU32 {
        (ARENA_BASE_ADDR + header().offset_hash32) as *mut AtomicU32
    }
    #[inline(always)]
    unsafe fn next_ptr() -> *mut AtomicU32 {
        (ARENA_BASE_ADDR + header().offset_next_idx) as *mut AtomicU32
    }
    #[inline(always)]
    unsafe fn buckets_ptr() -> *mut AtomicU32 {
        (ARENA_BASE_ADDR + header().offset_buckets) as *mut AtomicU32
    }
    #[inline(always)]
    unsafe fn term_cache_ptr() -> *mut AtomicU32 {
        (ARENA_BASE_ADDR + header().offset_term_cache) as *mut AtomicU32
    }

    // -------------------------------------------------------------------------
    // Hashing helpers
    // -------------------------------------------------------------------------
    fn avalanche32(mut x: u32) -> u32 {
        x ^= x >> 16;
        x = x.wrapping_mul(0x7feb_352d);
        x ^= x >> 15;
        x = x.wrapping_mul(0x846c_a68b);
        x ^= x >> 16;
        x
    }
    const GOLD: u32 = 0x9e37_79b9;
    fn mix(a: u32, b: u32) -> u32 {
        avalanche32(a ^ b.wrapping_mul(GOLD))
    }

    // If a resize fails (OOM / max cap), poison the seqlock so other threads trap
    // instead of spinning forever on an odd seq.
    const POISON_SEQ: u32 = 0xffff_ffff;

    // -------------------------------------------------------------------------
    // Resize guard (seqlock-style)
    // -------------------------------------------------------------------------
    // See "WASM atomics / CAS safety notes" above for CAS/ABA discussion.
    // This specific guard is seqlock-style: even=stable, odd=resize in progress.
    // For READING existing data. Returns (seq, h) to enable read-verify-retry pattern:
    // 1. Call enter_stable() to get sequence number
    // 2. Read the data you need
    // 3. Call check_stable(seq) to verify sequence didn't change
    // 4. If changed, retry (resize occurred during read)
    // Used in: kindOf(), symOf(), leftOf(), rightOf(), hash lookups
    #[inline(always)]
    fn enter_stable() -> (u32, &'static SabHeader) {
        unsafe {
            let h = header();
            loop {
                let seq = h.resize_seq.load(Ordering::Acquire);
                if seq == POISON_SEQ {
                    core::arch::wasm32::unreachable();
                }
                if seq & 1 == 1 {
                    core::hint::spin_loop();
                    continue;
                }
                return (seq, h);
            }
        }
    }

    // For WRITING new data. See comment above enter_stable() for distinction.
    // Simply waits until resize completes (sequence is even).
    // No verification needed since we're not reading existing data.
    // Used in: allocTerminal(), allocCons() allocation path, alloc_generic()
    #[inline(always)]
    fn wait_resize_stable() {
        unsafe {
            let h = header();
            loop {
                let seq = h.resize_seq.load(Ordering::Acquire);
                if seq == POISON_SEQ {
                    core::arch::wasm32::unreachable();
                }
                if (seq & 1) == 0 {
                    return;
                }
                core::hint::spin_loop();
            }
        }
    }

    #[inline(always)]
    fn check_stable(seq: u32) -> bool {
        unsafe { header().resize_seq.load(Ordering::Acquire) == seq }
    }

    // -------------------------------------------------------------------------
    // Arena init / connect
    // -------------------------------------------------------------------------
    unsafe fn zero_region(start: u32, len: u32) {
        core::ptr::write_bytes((ARENA_BASE_ADDR + start) as *mut u8, 0, len as usize);
    }

    unsafe fn init_header(capacity: u32) {
        let (offset_sq, offset_cq, total_size) = SabHeader::layout(capacity);
        let h = &mut *(ARENA_BASE_ADDR as *mut SabHeader);
        h.magic = ARENA_MAGIC;
        h.ring_entries = RING_ENTRIES;
        h.ring_mask = RING_ENTRIES - 1;
        h.offset_sq = offset_sq;
        h.offset_cq = offset_cq;
        h.offset_kind = align64(offset_cq + ring_bytes::<Cqe>(RING_ENTRIES));
        h.offset_sym = h.offset_kind + capacity;
        h.offset_left_id = align64(h.offset_sym + capacity);
        h.offset_right_id = h.offset_left_id + 4 * capacity;
        h.offset_hash32 = h.offset_right_id + 4 * capacity;
        h.offset_next_idx = h.offset_hash32 + 4 * capacity;
        h.offset_buckets = align64(h.offset_next_idx + 4 * capacity);
        h.offset_term_cache = h.offset_buckets + 4 * capacity;
        h.capacity = capacity;
        h.bucket_mask = capacity - 1;
        h.resize_seq.store(0, Ordering::Relaxed);
        h.top.store(0, Ordering::Relaxed);

        zero_region((core::mem::size_of::<SabHeader>()) as u32, total_size - core::mem::size_of::<SabHeader>() as u32);

        Ring::<Sqe>::init_at((ARENA_BASE_ADDR + h.offset_sq) as *mut u8, RING_ENTRIES);
        Ring::<Cqe>::init_at((ARENA_BASE_ADDR + h.offset_cq) as *mut u8, RING_ENTRIES);

        // Buckets + cache init
        let buckets = buckets_ptr();
        for i in 0..capacity as usize {
            buckets.add(i).write(AtomicU32::new(EMPTY));
        }
        let cache = term_cache_ptr();
        for i in 0..4 {
            cache.add(i).write(AtomicU32::new(EMPTY));
        }
    }

    unsafe fn allocate_raw_arena(capacity: u32) -> *mut SabHeader {
        let (_, _, total_size) = SabHeader::layout(capacity);
        let pages_needed = (total_size as usize + WASM_PAGE_SIZE - 1) / WASM_PAGE_SIZE;
        let old_pages = wasm32::memory_grow(0, pages_needed);
        if old_pages == usize::MAX {
            return core::ptr::null_mut();
        }
        let base_addr = (old_pages * WASM_PAGE_SIZE) as u32;
        ARENA_BASE_ADDR = base_addr;
        init_header(capacity);
        base_addr as *mut SabHeader
    }

    // -------------------------------------------------------------------------
    // Exports: init/connect/reset
    // -------------------------------------------------------------------------
    #[no_mangle]
    pub extern "C" fn initArena(initial_capacity: u32) -> u32 {
        if initial_capacity < 1024 || initial_capacity > MAX_CAP || !initial_capacity.is_power_of_two() {
            return 0;
        }
        unsafe {
            if ARENA_BASE_ADDR != 0 {
                return ARENA_BASE_ADDR;
            }
            let ptr = allocate_raw_arena(initial_capacity);
            if ptr.is_null() {
                return 1;
            }
            ARENA_MODE = 1;
            ARENA_BASE_ADDR
        }
    }

    #[no_mangle]
    pub extern "C" fn connectArena(ptr_addr: u32) -> u32 {
        if ptr_addr == 0 || ptr_addr % 64 != 0 {
            return 0;
        }
        unsafe {
            ARENA_BASE_ADDR = ptr_addr;
            ARENA_MODE = 1;
            let h = header();
            if h.magic != ARENA_MAGIC {
                return 5;
            }
            1
        }
    }

    #[no_mangle]
    pub extern "C" fn reset() {
        unsafe {
            ensure_arena();
            let h = header_mut();
            h.top.store(0, Ordering::Release);
            let buckets = buckets_ptr();
            for i in 0..h.capacity as usize {
                (*buckets.add(i)).store(EMPTY, Ordering::Release);
            }
            let cache = term_cache_ptr();
            for i in 0..4 {
                (*cache.add(i)).store(EMPTY, Ordering::Release);
            }
            h.resize_seq.store(h.resize_seq.load(Ordering::Relaxed) & !1, Ordering::Release);
        }
    }

    // -------------------------------------------------------------------------
    // Accessors
    // -------------------------------------------------------------------------
    #[no_mangle]
    pub extern "C" fn kindOf(n: u32) -> u32 {
        unsafe {
            ensure_arena();
            loop {
                let (seq, h) = enter_stable();
                let cap = h.capacity;
                if n >= cap {
                    return 0;
                }
                let val = (*kind_ptr().add(n as usize)).load(Ordering::Acquire) as u32;
                core::sync::atomic::fence(Ordering::Acquire);
                if check_stable(seq) {
                    return val;
                }
            }
        }
    }

    #[no_mangle]
    pub extern "C" fn symOf(n: u32) -> u32 {
        unsafe {
            ensure_arena();
            loop {
                let (seq, h) = enter_stable();
                if n >= h.capacity {
                    return 0;
                }
                let val = (*sym_ptr().add(n as usize)).load(Ordering::Acquire) as u32;
                core::sync::atomic::fence(Ordering::Acquire);
                if check_stable(seq) {
                    return val;
                }
            }
        }
    }

    #[no_mangle]
    pub extern "C" fn leftOf(n: u32) -> u32 {
        unsafe {
            ensure_arena();
            loop {
                let (seq, h) = enter_stable();
                if n >= h.capacity {
                    return 0;
                }
                let val = (*left_ptr().add(n as usize)).load(Ordering::Acquire);
                core::sync::atomic::fence(Ordering::Acquire);
                if check_stable(seq) {
                    return val;
                }
            }
        }
    }

    #[no_mangle]
    pub extern "C" fn rightOf(n: u32) -> u32 {
        unsafe {
            ensure_arena();
            loop {
                let (seq, h) = enter_stable();
                if n >= h.capacity {
                    return 0;
                }
                let val = (*right_ptr().add(n as usize)).load(Ordering::Acquire);
                core::sync::atomic::fence(Ordering::Acquire);
                if check_stable(seq) {
                    return val;
                }
            }
        }
    }

    // -------------------------------------------------------------------------
    // Allocation (speculative, lock-free)
    // -------------------------------------------------------------------------
    #[no_mangle]
    pub extern "C" fn allocTerminal(sym: u32) -> u32 {
        unsafe {
            ensure_arena();
            let h = header();

            if sym < 4 {
                let cached = (*term_cache_ptr().add(sym as usize)).load(Ordering::Acquire);
                if cached != EMPTY {
                    return cached;
                }
            }

            loop {
                wait_resize_stable();
                let id = h.top.fetch_add(1, Ordering::AcqRel);
                if id >= h.capacity {
                    grow();
                    continue;
                }

                (*kind_ptr().add(id as usize)).store(ArenaKind::Terminal as u8, Ordering::Release);
                (*sym_ptr().add(id as usize)).store(sym as u8, Ordering::Release);
                (*hash_ptr().add(id as usize)).store(sym, Ordering::Release);

                if sym < 4 {
                    (*term_cache_ptr().add(sym as usize)).store(id, Ordering::Release);
                }
                return id;
            }
        }
    }

    #[no_mangle]
    /// Allocate a NonTerm (application) node with hash-consing optimization.
    ///
    /// This is the core optimization that enables structural sharing in the arena.
    /// Instead of always creating new nodes, it checks if an identical `(l r)` pair
    /// already exists and returns the existing node ID if found.
    ///
    /// ## Hash-Consing Algorithm
    ///
    /// 1. **Compute hash**: `mix(hash(l), hash(r))` using avalanche hashing
    /// 2. **Lookup in hash table**: Check bucket for existing `(l,r)` pairs
    /// 3. **Return existing**: If found, return the shared node ID
    /// 4. **Allocate new**: If not found, create new node and add to hash table
    ///
    /// ## Memory Efficiency
    ///
    /// - **DAG representation**: Common subexpressions are shared
    /// - **Reduced allocations**: Avoids duplicate node creation
    /// - **Cache-friendly**: Hash table enables O(1) lookups
    ///
    /// ## Thread Safety
    ///
    /// - Uses seqlock to handle concurrent resizing
    /// - Atomic operations for hash table consistency
    /// - CAS-based insertion prevents race conditions
    pub extern "C" fn allocCons(l: u32, r: u32) -> u32 {
        unsafe {
            ensure_arena();

            // Compute hash value (doesn't depend on header state)
            let hl = loop {
                let (seq, h) = enter_stable();
                if l >= h.capacity {
                    if !check_stable(seq) { continue; }
                    return EMPTY; // Invalid left node
                }
                let val = (*hash_ptr().add(l as usize)).load(Ordering::Acquire);
                core::sync::atomic::fence(Ordering::Acquire);
                if check_stable(seq) {
                    break val;
                }
            };
            let hr = loop {
                let (seq, h) = enter_stable();
                if r >= h.capacity {
                    if !check_stable(seq) { continue; }
                    return EMPTY; // Invalid right node
                }
                let val = (*hash_ptr().add(r as usize)).load(Ordering::Acquire);
                core::sync::atomic::fence(Ordering::Acquire);
                if check_stable(seq) {
                    break val;
                }
            };
            let hval = mix(hl, hr);

            // Retry loop for stable reads
            let _ = loop {
                let (seq, h) = enter_stable(); // Wait if resizing
                let mask = h.bucket_mask;
                let bucket_idx = (hval & mask) as usize;

                // Validate bucket index is safe before dereferencing
                if bucket_idx >= h.capacity as usize {
                    // Capacity changed mid-read? Retry.
                    if !check_stable(seq) { continue; }
                    // Should be unreachable if logic is correct, but safe fallback
                    continue;
                }

                let buckets = buckets_ptr();
                let next = next_ptr();

                let mut cur = (*buckets.add(bucket_idx)).load(Ordering::Acquire);
                let mut found = EMPTY;

                while cur != EMPTY {
                    // Bounds check for safety
                    if cur >= h.capacity { break; }

                    let k = (*kind_ptr().add(cur as usize)).load(Ordering::Acquire);
                    if k == ArenaKind::NonTerm as u8 {
                        let ch = (*hash_ptr().add(cur as usize)).load(Ordering::Acquire);
                        if ch == hval {
                            let cl = (*left_ptr().add(cur as usize)).load(Ordering::Acquire);
                            let cr = (*right_ptr().add(cur as usize)).load(Ordering::Acquire);
                            if cl == l && cr == r {
                                found = cur;
                                break;
                            }
                        }
                    }
                    cur = (*next.add(cur as usize)).load(Ordering::Acquire);
                }

                // If we found it, verify the lock is still valid.
                // If lock changed, our read might be garbage -> Retry.
                if check_stable(seq) {
                    if found != EMPTY {
                        return found;
                    }
                    // If not found, we break to the allocation logic with bucket index
                    break bucket_idx;
                }
                // If lock changed, retry the whole lookup
            };

            // allocate new
            loop {
                wait_resize_stable();

                // Reload pointers/mask in case they changed during wait_resize_stable()
                let h = header();
                let buckets = buckets_ptr();
                let current_mask = h.bucket_mask;
                let b = (hval & current_mask) as usize;

                let id = h.top.fetch_add(1, Ordering::AcqRel);
                if id >= h.capacity {
                    grow();
                    continue;
                }

                (*kind_ptr().add(id as usize)).store(ArenaKind::NonTerm as u8, Ordering::Release);
                (*left_ptr().add(id as usize)).store(l, Ordering::Release);
                (*right_ptr().add(id as usize)).store(r, Ordering::Release);
                (*hash_ptr().add(id as usize)).store(hval, Ordering::Release);

                // insert into bucket with CAS; if we lose, drop id as hole (kind=0)
                let next = next_ptr();
                loop {
                    let head = (*buckets.add(b)).load(Ordering::Acquire);
                    (*next.add(id as usize)).store(head, Ordering::Relaxed);
                    // See "WASM atomics / CAS safety notes" above (cmpxchg winner/loser).
                    if (*buckets.add(b))
                        .compare_exchange(head, id, Ordering::Release, Ordering::Relaxed)
                        .is_ok()
                    {
                        return id;
                    }
                    // someone inserted; check if it matches now
                    let mut cur2 = (*buckets.add(b)).load(Ordering::Acquire);
                    while cur2 != EMPTY {
                        let ck2 = (*kind_ptr().add(cur2 as usize)).load(Ordering::Acquire);
                        if ck2 != ArenaKind::NonTerm as u8 {
                            cur2 = (*next.add(cur2 as usize)).load(Ordering::Acquire);
                            continue;
                        }
                        let ch2 = (*hash_ptr().add(cur2 as usize)).load(Ordering::Acquire);
                        if ch2 == hval {
                            let cl2 = (*left_ptr().add(cur2 as usize)).load(Ordering::Acquire);
                            let cr2 = (*right_ptr().add(cur2 as usize)).load(Ordering::Acquire);
                            if cl2 == l && cr2 == r {
                                // mark hole
                                (*kind_ptr().add(id as usize)).store(0, Ordering::Release);
                                return cur2;
                            }
                        }
                        cur2 = (*next.add(cur2 as usize)).load(Ordering::Acquire);
                    }
                }
            }
        }
    }

    // Generic allocation (non hash-consed; NOT inserted into buckets).
    // This is used for reducer continuations/suspensions.
    #[inline(always)]
    unsafe fn alloc_generic(kind: u8, sym: u8, left: u32, right: u32, hash: u32) -> u32 {
        ensure_arena();
        let h = header();
        loop {
            wait_resize_stable();
            let id = h.top.fetch_add(1, Ordering::AcqRel);
            if id >= h.capacity {
                grow();
                continue;
            }
            // Publish payload, then kind last.
            (*sym_ptr().add(id as usize)).store(sym, Ordering::Release);
            (*left_ptr().add(id as usize)).store(left, Ordering::Release);
            (*right_ptr().add(id as usize)).store(right, Ordering::Release);
            (*hash_ptr().add(id as usize)).store(hash, Ordering::Release);
            (*kind_ptr().add(id as usize)).store(kind, Ordering::Release);
            return id;
        }
    }

    // -------------------------------------------------------------------------
    // Resize (stop-the-world via odd/even seq)
    // -------------------------------------------------------------------------
    fn grow() {
        unsafe {
            let h = header_mut();
            let mut expected = h.resize_seq.load(Ordering::Acquire);
            loop {
                if expected & 1 == 1 {
                    core::hint::spin_loop();
                    expected = h.resize_seq.load(Ordering::Acquire);
                    continue;
                }
                // Acquire exclusive "writer" by flipping even->odd with CAS.
                // See "WASM atomics / CAS safety notes" above (cmpxchg winner/loser).
                if h.resize_seq.compare_exchange(expected, expected | 1, Ordering::AcqRel, Ordering::Acquire).is_ok() {
                    break;
                }
                expected = h.resize_seq.load(Ordering::Acquire);
            }

            let old_cap = h.capacity;
            // Capture OLD offsets before we overwrite the header with new ones.
            let old_offset_kind = h.offset_kind;
            let old_offset_sym = h.offset_sym;
            let old_offset_left = h.offset_left_id;
            let old_offset_right = h.offset_right_id;
            let old_offset_hash = h.offset_hash32;
            let old_offset_next = h.offset_next_idx;
            let old_offset_term_cache = h.offset_term_cache;
            let old_top = h.top.load(Ordering::Acquire);

            if old_cap >= MAX_CAP {
                // Poison so other threads trap instead of spinning on odd resize_seq.
                h.resize_seq.store(POISON_SEQ, Ordering::Release);
                core::arch::wasm32::unreachable();
            }
            let new_cap = (old_cap * 2).min(MAX_CAP);

            let (offset_sq, offset_cq, total_size) = SabHeader::layout(new_cap);
            let needed_bytes = ARENA_BASE_ADDR as usize + total_size as usize;
            let current_bytes = wasm32::memory_size(0) * WASM_PAGE_SIZE;
            if needed_bytes > current_bytes {
                let extra = needed_bytes - current_bytes;
                let pages = (extra + WASM_PAGE_SIZE - 1) / WASM_PAGE_SIZE;
                let res = wasm32::memory_grow(0, pages);
                if res == usize::MAX {
                    // OOM (or denied grow). Poison so other threads trap instead of spinning.
                    h.resize_seq.store(POISON_SEQ, Ordering::Release);
                    core::arch::wasm32::unreachable();
                }
            }

            // Compute new offsets (rings stay in place, but compute for completeness).
            let offset_kind = align64(offset_cq + ring_bytes::<Cqe>(RING_ENTRIES));
            let offset_sym = offset_kind + new_cap;
            let offset_left_id = align64(offset_sym + new_cap);
            let offset_right_id = offset_left_id + 4 * new_cap;
            let offset_hash32 = offset_right_id + 4 * new_cap;
            let offset_next_idx = offset_hash32 + 4 * new_cap;
            let offset_buckets = align64(offset_next_idx + 4 * new_cap);
            let offset_term_cache = offset_buckets + 4 * new_cap;

            // Update header (rings untouched)
            h.capacity = new_cap;
            h.bucket_mask = new_cap - 1;
            h.offset_sq = offset_sq;
            h.offset_cq = offset_cq;
            h.offset_kind = offset_kind;
            h.offset_sym = offset_sym;
            h.offset_left_id = offset_left_id;
            h.offset_right_id = offset_right_id;
            h.offset_hash32 = offset_hash32;
            h.offset_next_idx = offset_next_idx;
            h.offset_buckets = offset_buckets;
            h.offset_term_cache = offset_term_cache;

            // Preserve top
            let count = old_top.min(old_cap);
            h.top.store(count, Ordering::Release);

            // IMPORTANT: reverse-copy order is mandatory.
            // The layout is packed contiguously, and new_cap > old_cap means new regions can overlap
            // old regions during migration. Copy from the end back to the front.

            // Term cache (16 bytes)
            core::ptr::copy(
                (ARENA_BASE_ADDR + old_offset_term_cache) as *const u8,
                (ARENA_BASE_ADDR + h.offset_term_cache) as *mut u8,
                16,
            );

            // Next (u32)
            core::ptr::copy(
                (ARENA_BASE_ADDR + old_offset_next) as *const u8,
                (ARENA_BASE_ADDR + h.offset_next_idx) as *mut u8,
                (count as usize) * 4,
            );
            if new_cap > old_cap {
                zero_region(
                    h.offset_next_idx + old_cap * 4,
                    (new_cap - old_cap) * 4,
                );
            }

            // Hash (u32)
            core::ptr::copy(
                (ARENA_BASE_ADDR + old_offset_hash) as *const u8,
                (ARENA_BASE_ADDR + h.offset_hash32) as *mut u8,
                (count as usize) * 4,
            );
            if new_cap > old_cap {
                zero_region(
                    h.offset_hash32 + old_cap * 4,
                    (new_cap - old_cap) * 4,
                );
            }

            // Right (u32)
            core::ptr::copy(
                (ARENA_BASE_ADDR + old_offset_right) as *const u8,
                (ARENA_BASE_ADDR + h.offset_right_id) as *mut u8,
                (count as usize) * 4,
            );
            if new_cap > old_cap {
                zero_region(
                    h.offset_right_id + old_cap * 4,
                    (new_cap - old_cap) * 4,
                );
            }

            // Left (u32)
            core::ptr::copy(
                (ARENA_BASE_ADDR + old_offset_left) as *const u8,
                (ARENA_BASE_ADDR + h.offset_left_id) as *mut u8,
                (count as usize) * 4,
            );
            if new_cap > old_cap {
                zero_region(
                    h.offset_left_id + old_cap * 4,
                    (new_cap - old_cap) * 4,
                );
            }

            // Sym (u8)
            core::ptr::copy(
                (ARENA_BASE_ADDR + old_offset_sym) as *const u8,
                (ARENA_BASE_ADDR + h.offset_sym) as *mut u8,
                count as usize,
            );
            if new_cap > old_cap {
                zero_region(
                    h.offset_sym + old_cap,
                    new_cap - old_cap,
                );
            }

            // Kind (u8)
            core::ptr::copy(
                (ARENA_BASE_ADDR + old_offset_kind) as *const u8,
                (ARENA_BASE_ADDR + h.offset_kind) as *mut u8,
                count as usize,
            );
            if new_cap > old_cap {
                zero_region(
                    h.offset_kind + old_cap,
                    new_cap - old_cap,
                );
            }

            // Rebuild buckets (hash-consing table) for NonTerm only.
            let buckets = buckets_ptr();
            let next = next_ptr();
            for i in 0..new_cap as usize {
                (*buckets.add(i)).store(EMPTY, Ordering::Release);
            }
            for i in 0..count {
                let k = (*kind_ptr().add(i as usize)).load(Ordering::Acquire);
                if k != ArenaKind::NonTerm as u8 {
                    continue;
                }
                let hv = (*hash_ptr().add(i as usize)).load(Ordering::Acquire);
                let b = (hv & h.bucket_mask) as usize;
                loop {
                    let head = (*buckets.add(b)).load(Ordering::Acquire);
                    (*next.add(i as usize)).store(head, Ordering::Relaxed);
                    // See "WASM atomics / CAS safety notes" above (cmpxchg winner/loser).
                    if (*buckets.add(b))
                        .compare_exchange(head, i, Ordering::Release, Ordering::Relaxed)
                        .is_ok()
                    {
                        break;
                    }
                }
            }

            h.resize_seq.fetch_add(1, Ordering::Release);
        }
    }

    // -------------------------------------------------------------------------
    // Reducer
    // -------------------------------------------------------------------------
    // Continuation frame: kind=Continuation, sym=stage, left=parent_stack, right=parent_node
    const STAGE_LEFT: u8 = 0;
    const STAGE_RIGHT: u8 = 1;

    // Suspension: kind=Suspension, sym=mode (0=descend, 1=return), left=curr, right=stack, hash=remaining_steps
    const MODE_DESCEND: u8 = 0;
    const MODE_RETURN: u8 = 1;

    #[inline(always)]
    unsafe fn alloc_continuation(parent: u32, target: u32, stage: u8) -> u32 {
        alloc_generic(ArenaKind::Continuation as u8, stage, parent, target, 0)
    }

    #[inline(always)]
    unsafe fn alloc_suspension(curr: u32, stack: u32, mode: u8, remaining_steps: u32) -> u32 {
        alloc_generic(ArenaKind::Suspension as u8, mode, curr, stack, remaining_steps)
    }

    // --- OPTIMIZATION: Update existing node (Slot Reuse) ---
    #[inline(always)]
    unsafe fn update_continuation(id: u32, parent: u32, target: u32, stage: u8) {
        (*left_ptr().add(id as usize)).store(parent, Ordering::Relaxed);
        (*right_ptr().add(id as usize)).store(target, Ordering::Relaxed);
        (*sym_ptr().add(id as usize)).store(stage, Ordering::Relaxed);
        // Ensure it is marked as Continuation (in case we recycled a Suspension)
        (*kind_ptr().add(id as usize)).store(ArenaKind::Continuation as u8, Ordering::Release);
    }

    #[inline(always)]
    fn hash_of_internal(n: u32) -> u32 {
        unsafe {
            ensure_arena();
            loop {
                let (seq, h) = enter_stable();
                if n >= h.capacity {
                    return 0;
                }
                let val = (*hash_ptr().add(n as usize)).load(Ordering::Acquire);
                core::sync::atomic::fence(Ordering::Acquire);
                if check_stable(seq) {
                    return val;
                }
            }
        }
    }

    /// Unwind the continuation stack to reconstruct the full expression tree.
    ///
    /// When the step limit is exhausted, the worker may be deep in the expression tree
    /// with a non-empty stack. This function walks up the stack, rebuilding parent nodes
    /// as necessary, to return the root of the expression rather than a sub-expression.
    #[inline(always)]
    unsafe fn unwind_to_root(mut curr: u32, mut stack: u32) -> u32 {
        while stack != EMPTY {
            let recycled = stack;
            stack = leftOf(recycled);
            let parent_node = rightOf(recycled);
            let stage = symOf(recycled) as u8;

            if stage == STAGE_LEFT {
                let orig_left = leftOf(parent_node);
                if curr != orig_left {
                    // Left child changed, must allocate new parent
                    curr = allocCons(curr, rightOf(parent_node));
                } else {
                    // Left child didn't change, reuse existing parent
                    curr = parent_node;
                }
            } else {
                // STAGE_RIGHT
                let orig_right = rightOf(parent_node);
                if curr != orig_right {
                    // Right child changed, must allocate new parent
                    curr = allocCons(leftOf(parent_node), curr);
                } else {
                    curr = parent_node;
                }
            }
        }
        curr
    }

    enum StepResult {
        Done(u32),
        Yield(u32), // Suspension node id
    }

    /// Perform one iterative reduction step with preemptive yielding.
    ///
    /// This implements the core SKI reduction algorithm using an iterative approach
    /// with explicit stack management instead of recursion. It can yield mid-step
    /// when traversal gas is exhausted, enabling cooperative multitasking.
    ///
    /// ## Iterative Reduction Algorithm
    ///
    /// Instead of recursive function calls, uses an explicit stack of Continuation nodes:
    ///
    /// - **MODE_DESCEND**: Traverse down the expression tree looking for redexes
    /// - **MODE_RETURN**: Return up the tree after reducing a subexpression
    /// - **Continuation frames**: Represent suspended stack frames as arena nodes
    ///
    /// ## Gas-Based Preemption
    ///
    /// - **Traversal gas**: Limits AST traversal depth per step
    /// - **Yield on exhaustion**: Returns Suspension node for later resumption
    /// - **Cooperative multitasking**: Prevents worker starvation in parallel evaluation
    ///
    /// ## Step Counting
    ///
    /// - **Accurate counting**: Decrements `remaining_steps` immediately when each reduction occurs
    /// - **Multiple reductions per call**: Can perform multiple reductions in a single call
    /// - **Deterministic**: Every reduction is counted exactly once, regardless of batching
    ///
    /// ## Node Recycling Optimization
    ///
    /// - **Free node reuse**: Dead continuation frames are recycled immediately
    /// - **Memory efficiency**: Reduces allocation pressure during reduction
    /// - **Cache locality**: Reuses recently freed nodes
    ///
    /// ## Parameters
    ///
    /// - `curr`: Current expression node being evaluated
    /// - `stack`: Stack of continuation frames (linked list of nodes)
    /// - `mode`: Current evaluation mode (descend/return)
    /// - `gas`: Remaining traversal gas (mutable, decremented during execution)
    /// - `remaining_steps`: Mutable reference to reduction steps remaining (decremented on each reduction)
    /// - `free_node`: Recyclable node ID from previous operations
    ///
    /// ## Returns
    ///
    /// - `StepResult::Done(node)`: Reduction completed, `node` is the result
    /// - `StepResult::Yield(susp_id)`: Yielded mid-step, `susp_id` is Suspension node
    unsafe fn step_iterative(mut curr: u32, mut stack: u32, mut mode: u8, gas: &mut u32, remaining_steps: &mut u32, mut free_node: u32) -> StepResult {
        loop {
            // Gas exhaustion yield
            if *gas == 0 {
                // If we have a free_node we didn't use, it's just a hole now.
                return StepResult::Yield(alloc_suspension(curr, stack, mode, *remaining_steps));
            }
            *gas -= 1;

            if mode == MODE_RETURN {
                if stack == EMPTY {
                    return StepResult::Done(curr);
                }

                // POP FRAME
                let recycled = stack;         // <--- This frame is now dead/recyclable
                stack = leftOf(recycled);     // Parent
                let parent_node = rightOf(recycled);
                let stage = symOf(recycled) as u8;

                if stage == STAGE_LEFT {
                    let orig_left = leftOf(parent_node);
                    if curr != orig_left {
                        // Rebuild parent
                        curr = allocCons(curr, rightOf(parent_node));
                        // 'recycled' is still free, we are returning up.
                        free_node = recycled; // Keep for next push or pop
                        mode = MODE_RETURN;
                        continue;
                    }
                    // Left stable, DESCEND RIGHT
                    // Reuse 'recycled' as the new Continuation frame!
                    update_continuation(recycled, stack, parent_node, STAGE_RIGHT);
                    stack = recycled;
                    mode = MODE_DESCEND;
                    curr = rightOf(parent_node);
                    continue;
                } else {
                    let orig_right = rightOf(parent_node);
                    if curr != orig_right {
                        curr = allocCons(leftOf(parent_node), curr);
                        free_node = recycled;
                        mode = MODE_RETURN;
                        continue;
                    }
                    // Both stable
                    curr = parent_node;
                    free_node = recycled;
                    mode = MODE_RETURN;
                    continue;
                }
            }

            // MODE_DESCEND
            let k = kindOf(curr);
            if k != ArenaKind::NonTerm as u32 {
                mode = MODE_RETURN;
                continue;
            }

            // NonTerm: check for I/K/S redex at this node.
            let left = leftOf(curr);
            let right = rightOf(curr);

            // [REDUCTION LOGIC START] -----------------------------------------

            // I x -> x
            if kindOf(left) == ArenaKind::Terminal as u32 && symOf(left) == ArenaSym::I as u32 {
                if *remaining_steps == 0 {
                    return StepResult::Yield(alloc_suspension(curr, stack, mode, 0));
                }
                *remaining_steps = remaining_steps.saturating_sub(1);

                curr = right;
                mode = MODE_RETURN;

                // Yield IMMEDIATELY if limit hit zero.
                // Don't waste gas traversing to the next redex.
                if *remaining_steps == 0 {
                    return StepResult::Yield(alloc_suspension(curr, stack, mode, 0));
                }
                continue;
            }

            if kindOf(left) == ArenaKind::NonTerm as u32 {
                let ll = leftOf(left);
                // K x y -> x
                if kindOf(ll) == ArenaKind::Terminal as u32 && symOf(ll) == ArenaSym::K as u32 {
                    if *remaining_steps == 0 {
                        return StepResult::Yield(alloc_suspension(curr, stack, mode, 0));
                    }
                    *remaining_steps = remaining_steps.saturating_sub(1);

                    curr = rightOf(left);
                    mode = MODE_RETURN;

                    // Yield IMMEDIATELY
                    if *remaining_steps == 0 {
                        return StepResult::Yield(alloc_suspension(curr, stack, mode, 0));
                    }
                    continue;
                }
                // S x y z -> x z (y z)
                if kindOf(ll) == ArenaKind::NonTerm as u32 {
                    let lll = leftOf(ll);
                    if kindOf(lll) == ArenaKind::Terminal as u32 && symOf(lll) == ArenaSym::S as u32 {
                        if *remaining_steps == 0 {
                            return StepResult::Yield(alloc_suspension(curr, stack, mode, 0));
                        }
                        // Use saturating_sub for consistency
                        *remaining_steps = remaining_steps.saturating_sub(1);

                        let x = rightOf(ll);
                        let y = rightOf(left);
                        let z = right;
                        let xz = allocCons(x, z);
                        let yz = allocCons(y, z);
                        curr = allocCons(xz, yz);
                        mode = MODE_RETURN;

                        // Yield IMMEDIATELY
                        if *remaining_steps == 0 {
                            return StepResult::Yield(alloc_suspension(curr, stack, mode, 0));
                        }
                        continue;
                    }
                }
            }

            // [REDUCTION LOGIC END] -------------------------------------------

            // No redex: PUSH frame to descend left
            if free_node != EMPTY {
                update_continuation(free_node, stack, curr, STAGE_LEFT);
                stack = free_node;
                free_node = EMPTY;
            } else {
                stack = alloc_continuation(stack, curr, STAGE_LEFT);
            }
            curr = left;
            mode = MODE_DESCEND;
        }
    }

    fn step_internal(expr: u32) -> u32 {
        unsafe {
            let mut gas = u32::MAX;
            let mut steps = u32::MAX; // Dummy - not used for single-step calls
            match step_iterative(expr, EMPTY, MODE_DESCEND, &mut gas, &mut steps, EMPTY) {
                StepResult::Done(x) => x,
                StepResult::Yield(_) => expr, // unreachable with u32::MAX gas; keep total safety
            }
        }
    }

    #[no_mangle]
    pub extern "C" fn arenaKernelStep(expr: u32) -> u32 {
        unsafe { ensure_arena(); }
        step_internal(expr)
    }

    #[no_mangle]
    pub extern "C" fn reduce(expr: u32, max: u32) -> u32 {
        unsafe { ensure_arena(); }
        let limit = if max == 0xffff_ffff { u32::MAX } else { max };
        let mut cur = expr;
        for _ in 0..limit {
            let next = step_internal(cur);
            if next == cur {
                break;
            }
            cur = next;
        }
        cur
    }

    // -------------------------------------------------------------------------
    // Host/worker ring APIs
    // -------------------------------------------------------------------------
    #[no_mangle]
    pub extern "C" fn hostPull() -> i64 {
        unsafe {
            if ARENA_BASE_ADDR == 0 {
                return -1;
            }
            if let Some(cqe) = cq_ring().try_dequeue() {
                // Pack: high 32 bits = req_id, low 32 bits = node_id
                let packed: u64 = ((cqe.req_id as u64) << 32) | (cqe.node_id as u64);
                packed as i64
            } else {
                -1
            }
        }
    }

    #[no_mangle]
    /// Submit work with explicit correlation id and max reduction steps.
    /// Returns: 0=ok, 1=full, 2=not connected.
    pub extern "C" fn hostSubmit(node_id: u32, req_id: u32, max_steps: u32) -> u32 {
        unsafe {
            if ARENA_BASE_ADDR == 0 {
                return 2;
            }
            if sq_ring().try_enqueue(Sqe { node_id, req_id, max_steps }) {
                0
            } else {
                1
            }
        }
    }

    /// Main worker loop for parallel SKI evaluation.
    ///
    /// Processes evaluation requests from the submission queue and posts results
    /// to the completion queue. Implements preemptive multitasking using gas-based
    /// yielding to prevent worker starvation in concurrent workloads.
    ///
    /// ## Processing Model
    ///
    /// 1. **Dequeue request** from submission queue (blocking)
    /// 2. **Initialize evaluation state** from request or suspension
    /// 3. **Iterative reduction loop** with gas-based preemption
    /// 4. **Yield or complete** based on gas and step limits
    /// 5. **Enqueue result** to completion queue
    /// 6. **Repeat** for next request
    ///
    /// ## Preemption Strategy
    ///
    /// - **Batch gas limit**: `20,000` AST nodes per dequeue batch
    /// - **Cooperative yielding**: Returns control when gas exhausted
    /// - **Suspension resumption**: Can restart from any yield point
    /// - **Fair scheduling**: Prevents any single expression from monopolizing CPU
    ///
    /// ## Step Counting Semantics
    ///
    /// - **Step decrement**: Only occurs when `StepResult::Done` is returned (step completed)
    /// - **Yield behavior**: When `step_iterative` yields, it saves the UN-DECREMENTED `remaining_steps`
    ///   because the step did not finish. This is correct: the suspension captures the state before
    ///   the step completes, so resumption continues with the same budget.
    /// - **Deterministic counting**: Each reduction step is counted exactly once, regardless of
    ///   how many times the work is suspended and resumed.
    ///
    /// ## Memory Management
    ///
    /// - **Node recycling**: Reuses dead continuation frames immediately
    /// - **Shared arena**: All workers access the same memory space
    /// - **Atomic operations**: Safe concurrent access to shared structures
    ///
    /// ## Performance Optimizations
    ///
    /// - **Lock-free queues**: Minimal synchronization overhead
    /// - **Batched processing**: Amortizes dequeue overhead
    /// - **In-place updates**: Modifies nodes directly in shared memory
    /// - **Cache-friendly**: Sequential memory access patterns
    #[no_mangle]
    pub extern "C" fn workerLoop() {
        unsafe {
            let sq = sq_ring();
            let cq = cq_ring();
            // Per-dequeue traversal gas (preemption) to prevent starvation.
            // This is NOT the same as max reduction steps.
            let batch_gas: u32 = 20000;
            loop {
                let job = sq.dequeue_blocking();
                let mut curr = job.node_id;
                let mut stack = EMPTY;
                let mut mode = MODE_DESCEND;
                let mut remaining_steps: u32;

                // If resuming a suspension, the suspension node ITSELF is now free to be reused!
                let mut free_node = EMPTY;

                // Resume from suspension?
                if kindOf(curr) == ArenaKind::Suspension as u32 {
                    let susp = curr;
                    curr = leftOf(susp);
                    stack = rightOf(susp);
                    mode = symOf(susp) as u8;
                    // Strict resume: Trust the suspension's counter 100%
                    // The suspension node's hash field contains the remaining_steps that were
                    // saved when the step yielded (before decrement, because the step didn't finish).
                    remaining_steps = hash_of_internal(susp);
                    free_node = susp; // <--- RECYCLE START
                } else {
                    // Set strict limit from the job packet
                    let limit = job.max_steps;
                    remaining_steps = if limit == 0xffff_ffff { u32::MAX } else { limit };
                }

                loop {
                    // Check budget BEFORE trying a step
                    if remaining_steps == 0 {
                        // If we have a stack, we are deep in the tree.
                        // We must unwind to the root to return a valid full expression.
                        if stack != EMPTY {
                            curr = unwind_to_root(curr, stack);
                            stack = EMPTY;
                        }

                        // Step budget exhausted; return (partial) result.
                        cq.enqueue_blocking(Cqe {
                            node_id: curr,
                            req_id: job.req_id,
                            _pad: 0,
                        });
                        break;
                    }

                    let mut gas = batch_gas;

                    match step_iterative(curr, stack, mode, &mut gas, &mut remaining_steps, free_node) {
                        StepResult::Yield(susp_id) => {
                            // Yielded (gas or limit). 'susp_id' has the correct remaining count
                            // because step_iterative updated 'remaining_steps' in place for each
                            // reduction that occurred before yielding.
                            cq.enqueue_blocking(Cqe {
                                node_id: susp_id,
                                req_id: job.req_id,
                                _pad: 0,
                            });
                            break;
                        }
                        StepResult::Done(next_node) => {
                            if next_node == curr {
                                // Fixpoint reached.
                                cq.enqueue_blocking(Cqe {
                                    node_id: curr,
                                    req_id: job.req_id,
                                    _pad: 0,
                                });
                                break;
                            }

                            // Setup for next iteration
                            curr = next_node;
                            stack = EMPTY;
                            mode = MODE_DESCEND;
                            free_node = EMPTY;

                            // Loop continues; 'remaining_steps' was updated by reference in step_iterative
                        }
                    }
                }
            }
        }
    }

    // -------------------------------------------------------------------------
    // Debug helpers
    // -------------------------------------------------------------------------
    #[no_mangle]
    pub extern "C" fn debugGetArenaBaseAddr() -> u32 {
        unsafe { ARENA_BASE_ADDR }
    }

    #[no_mangle]
    pub extern "C" fn getArenaMode() -> u32 {
        unsafe { ARENA_MODE }
    }

    #[no_mangle]
    pub extern "C" fn debugCalculateArenaSize(capacity: u32) -> u32 {
        let (_, _, total_size) = SabHeader::layout(capacity);
        total_size
    }

    #[no_mangle]
    pub extern "C" fn debugLockState() -> u32 {
        // Full resize sequence word:
        // - even: stable
        // - odd:  resize in progress
        // - 0xFFFF_FFFF: poisoned (unrecoverable resize failure)
        unsafe { header().resize_seq.load(Ordering::Relaxed) }
    }
}

// Re-export WASM symbols at crate root
#[cfg(target_arch = "wasm32")]
pub use wasm::*;
