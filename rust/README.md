# typed-ski Rust Core

This directory contains the Rust implementation of a hash-consing multi-threaded
arena allocator for SKI expressions.

## Overview

**This Rust code is currently only for WebAssembly (WASM).** It is compiled to
WebAssembly and used by the TypeScript/Deno library to provide high-performance
evaluation of SKI combinator calculus expressions.

The implementation provides a thread-safe arena allocator with
[hash consing][hash-consing], which deduplicates structurally identical SKI
expressions. This enables efficient memory usage and fast equality checks by
ensuring that identical expressions share the same node ID.

[hash-consing]: https://en.wikipedia.org/wiki/Hash_consing

## Architecture

The arena allocator supports two modes:

- **Single-threaded (Heap Mode)**: Uses local WASM memory with lazy allocation
- **Multi-threaded (SAB Mode)**: Uses
  [WebAssembly shared memory][wasm-shared-memory] (SharedArrayBuffer) to enable
  concurrent access from multiple Web Workers, with atomic operations and
  lock striping for thread safety

Hash consing is implemented using a hash table with chaining, ensuring that
expressions with the same structure (same left and right children) are
automatically deduplicated. The arena can grow dynamically up to a fixed maximum
capacity.

### Thread Safety and Locking

In SAB (SharedArrayBuffer) mode, the arena uses a sophisticated locking scheme
to enable high-performance concurrent access:

#### Lock Striping

The arena uses **lock striping** with 64 independent locks to minimize
contention. Each hash bucket is mapped to one of 64 locks using a bitwise mask
of the hash value, allowing concurrent operations on different buckets to proceed
in parallel without blocking each other.

#### Tri-State Mutex

Each lock uses a **tri-state mutex** implementation:

- **State 0**: Unlocked (available)
- **State 1**: Locked, no contention (fast path - no waiters)
- **State 2**: Locked, with contention (slow path - threads are sleeping)

This design enables an optimized unlock path: if the lock was in state 1, no
wakeup notification is needed. If it was in state 2, the unlocker must wake up
sleeping threads using `memory.atomic.notify`.

#### Locking Strategy

The locking implementation uses a multi-phase approach:

1. **Fast Path**: Try to acquire the lock with a single atomic compare-and-swap
   (CAS) operation. If successful, set state to 1 and return immediately.

2. **Spin Phase**: If the fast path fails, spin for up to 100 iterations with
   random exponential backoff to handle short-duration locks without the overhead
   of system calls.

3. **Park Phase**: For longer-held locks, threads mark the lock as contended
   (state 2) and use `memory.atomic.wait32` to sleep until woken by the unlocker.

#### Thread Configuration

The arena uses a JavaScript host import (`js_allow_block`) to determine whether
a thread can block:

- **Main Thread**: Returns `0` - must use spin-only locking (cannot call
  `memory.atomic.wait32` as it would block the main event loop)
- **Worker Threads**: Return `1` - can use blocking waits for better CPU
  efficiency under contention

This configuration is instance-local (stored in each WASM instance's JavaScript
closure), avoiding shared memory state collisions between main thread and workers.

#### Resize Synchronization

Arena growth uses a "Stop the World" approach:

- **Resize Lock**: A global lock that must be acquired before resizing
- **Sequence Lock**: A lock-free mechanism for readers to detect concurrent
  resizes. The sequence number is incremented to an odd value before resize
  starts and to an even value after completion. Readers check that the sequence
  is even and unchanged during their read operation.

During resize, all 64 stripe locks are acquired in order to prevent deadlocks,
ensuring exclusive access for the rehashing operation.

### Memory Layout

The arena uses a [Structure of Arrays (SoA)][soa] layout, storing node data in
separate parallel arrays:

- `kind`: Node type (terminal or non-terminal)
- `sym`: Terminal symbol (for terminal nodes)
- `leftId`: Left child node ID
- `rightId`: Right child node ID
- `hash32`: Precomputed hash value for hash consing
- `nextIdx`: Hash table chain pointer

The host (TypeScript/JavaScript) can create typed array views (`Uint8Array`,
`Uint32Array`) directly over the WASM memory buffer to access these arrays
without function call overhead. This enables O(1) direct memory access from
JavaScript while maintaining thread safety through the arena's locking
mechanism.

[wasm-shared-memory]: https://webassembly.github.io/spec/core/syntax/modules.html#memories
[soa]: https://en.wikipedia.org/wiki/AoS_and_SoA

## Structure

- `src/lib.rs` - Library entry point
- `src/arena.rs` - Hash-consing multi-threaded arena allocator for SKI
  expressions

## Building

The build is managed by Nix. The `Cargo.toml` is generated automatically by the
Nix flake with the correct version.

To build manually:

```bash
# Generate Cargo.toml
nix run .#generate-cargo

# Build for WASM target
cargo build --target wasm32-unknown-unknown --release
```

## WASM Exports

The following functions are exported for use in JavaScript/TypeScript:

### Core Operations

- `initArena(capacity: u32) -> u32` - Initialize arena with specified capacity
  (must be power of 2, returns arena header address or error code)
- `connectArena(ptr: u32) -> u32` - Connect to existing SharedArrayBuffer arena
  (returns 1 on success, error code on failure)
- `kindOf(n: u32) -> u32` - Get node kind (uses lock-free reads with sequence
  lock validation in SAB mode)
- `symOf(n: u32) -> u32` - Get terminal symbol
- `leftOf(n: u32) -> u32` - Get left child
- `rightOf(n: u32) -> u32` - Get right child
- `reset()` - Reset arena state (acquires all locks for safety)
- `allocTerminal(sym: u32) -> u32` - Allocate terminal node (thread-safe)
- `allocCons(left: u32, right: u32) -> u32` - Allocate cons cell with hash
  consing (uses lock striping for concurrent access)
- `arenaKernelStep(expr: u32) -> u32` - Perform one reduction step
- `reduce(expr: u32, max: u32) -> u32` - Reduce to normal form

### Debug/Diagnostic Functions

- `debugLockState() -> u32` - Get current state of resize lock (0/1/2)
- `getArenaMode() -> u32` - Get arena mode (0 = heap, 1 = SAB)
- `debugGetArenaBaseAddr() -> u32` - Get arena base address
- `debugGetLockAcquisitionCount() -> u32` - Get total lock acquisitions
- `debugGetLockReleaseCount() -> u32` - Get total lock releases
- `debugCalculateArenaSize(capacity: u32) -> u32` - Calculate total arena size
- `debugGetMemorySize() -> u32` - Get current WASM memory size in pages

### WASM Imports

The arena requires the following JavaScript imports (provided via `env` module):

- `memory: WebAssembly.Memory` - The shared memory instance (must be created
  with `shared: true` for SAB mode)
- `js_allow_block() -> i32` - Returns `0` for main thread (spin-only) or `1`
  for worker threads (can block). This is instance-local and not stored in
  shared memory to avoid state collisions.

## Publishing

The Rust crate is published to crates.io alongside the JSR package.
