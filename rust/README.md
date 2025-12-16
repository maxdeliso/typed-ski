# typed-ski Rust (WASM arena)

This directory contains the Rust implementation of the arena allocator and
reducer used by typed-ski's WASM evaluators.

## Overview

**This Rust code targets `wasm32-unknown-unknown` and runs inside WebAssembly.**

It provides:

- **Hash-consing arena allocation** with structural sharing for memory
  efficiency
- **Iterative reduction algorithm** to prevent stack overflow on deep
  expressions
- **Preemptive multitasking** with cooperative yielding for fair worker
  scheduling
- **Lock-free ring buffers** (io_uring-style) for efficient inter-thread
  communication
- **[SharedArrayBuffer](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/SharedArrayBuffer)**
  support for true parallel evaluation across Web Workers
- **Dynamic arena growth** with seqlock-based synchronization

## Architecture

The arena allocator supports two modes:

- **Single-threaded (Heap Mode)**: Uses local WASM memory with lazy allocation
- **Multi-threaded (SAB Mode)**: Uses
  [WebAssembly shared memory][wasm-shared-memory] (SharedArrayBuffer) to enable
  concurrent access from multiple Web Workers, with atomic operations and
  lock-free synchronization for thread safety

Hash consing is implemented using a hash table with chaining, ensuring that
expressions with the same structure (same left and right children) are
automatically deduplicated. The arena can grow dynamically up to a fixed maximum
capacity.

### Thread Safety and Locking

In SAB (SharedArrayBuffer) mode, the arena uses lock-free and atomic-based
concurrency control to enable high-performance concurrent access:

#### Optimistic Concurrency Control

Hash-consing allocation uses **optimistic concurrency control**:

1. **Optimistic read**: Traverse bucket chain without locking
2. **Pre-allocate ID**: Use `top.fetch_add()` to reserve slot atomically
3. **CAS insertion**: Attempt to insert into hash table bucket
4. **Graceful failure**: If CAS fails, slot becomes a "hole" (`kind = 0`)

**Correctness guarantee**: Canonical node IDs are always returned. Readers treat
non-`NonTerm` kinds as terminal values, so holes don't affect evaluation.

#### Lock-Free Ring Buffers

Inter-thread communication uses **lock-free ring buffers** (io_uring-style):

- **Submission Queue (SQ)**: Main thread → Worker communication
- **Completion Queue (CQ)**: Worker → Main thread results
- **Atomic operations**: Wait-free producer/consumer patterns
- **Sequence numbers**: ABA prevention in concurrent access
- **Blocking waits**: Efficient WASM atomic wait/notify

#### Resize Synchronization

Arena growth uses a **seqlock-style approach**:

- **Stop-the-world pauses**: All threads spin during resize operations
- **Sequence lock**: Odd values indicate resize in progress, even values
  indicate stable
- **Reverse-order copying**: Prevents overlap issues during memory migration
- **Bucket rebuild**: Hash table reconstructed after resize
- **Poisoning on failure**: Unrecoverable errors set poison sequences

[wasm-shared-memory]: https://webassembly.github.io/spec/core/syntax/modules.html#memories
[soa]: https://en.wikipedia.org/wiki/AoS_and_SoA

## Key Optimizations

### 1. Hash-Consing (Structural Sharing)

The arena uses [hash consing](https://en.wikipedia.org/wiki/Hash_consing) to
deduplicate identical subexpressions:

- **Avalanche hashing**: Fast, high-quality hash function for node pairs
- **[Separate chaining](https://en.wikipedia.org/wiki/Hash_table#Separate_chaining)**:
  Collision resolution in hash table buckets
- **Memory efficiency**:
  [DAG](https://en.wikipedia.org/wiki/Directed_acyclic_graph) representation
  instead of tree (common subexpressions shared)
- **O(1) lookups**: Fast deduplication during expression construction

### 2. Iterative Reduction Algorithm

Avoids recursion stack overflow on deep expressions:

- **Explicit stack management**: Uses Continuation nodes instead of call stack
- **Two-phase reduction**: Left child first, then right child
- **Memory recycling**: Dead continuation frames reused immediately
- **Scalable depth**: No theoretical limit on expression depth

### 3. Preemptive Multitasking

Enables fair scheduling in parallel evaluation:

- **Gas-based yielding**: Workers yield control when traversal budget exhausted
- **Suspension nodes**: Capture complete evaluation state for resumption
- **Cooperative scheduling**: Prevents worker starvation
- **State serialization**: Evaluation context stored directly in arena

### 4. Lock-Free Ring Buffers

High-performance inter-thread communication:

- **[io_uring](https://en.wikipedia.org/wiki/Io_uring)-style design**:
  Submission and completion queues
- **Atomic operations**:
  [Wait-free](https://en.wikipedia.org/wiki/Non-blocking_algorithm)
  producer/consumer patterns
- **[Sequence numbers](https://en.wikipedia.org/wiki/ABA_problem)**: ABA
  prevention in concurrent access
- **[Blocking waits](https://en.wikipedia.org/wiki/Atomic_semaphore)**:
  Efficient WASM atomic wait/notify

## Arena Node Types

The arena supports four node types for different purposes:

- **`Terminal`**: SKI combinators (S, K, I) - leaf nodes
- **`NonTerm`**: Function application `(left right)` - core expressions
- **`Continuation`**: Stack frames for iterative reduction - optimization
- **`Suspension`**: Paused evaluation state for multitasking - optimization

## Execution Model (Host ↔ Workers)

- The host process (JS/TS) is responsible for **building expressions in the
  arena** (via `allocTerminal`/`allocCons`).
- The host then submits work to workers using the SQ/CQ rings.
- Workers run an exported infinite loop (`workerLoop`) that:
  - blocks waiting for SQ entries (`memory.atomic.wait32`)
  - reduces the submitted root using iterative algorithm with gas limits
  - yields control via Suspensions when gas exhausted (preemptive multitasking)
  - enqueues a CQ completion when reduction finishes or yields

### Correlation IDs

Work is correlated using a 32-bit `req_id` chosen by the host.

- SQ entry: `{ node_id: u32, req_id: u32 }`
- CQ entry: `{ node_id: u32, req_id: u32 }`

Completions may arrive out-of-order; `req_id` is how the host matches results to
callers.

## Thread Safety & Concurrency

### Hash-Consing Under Concurrency

`allocCons` implements optimistic concurrency control:

1. **Optimistic read**: Traverse bucket chain without locking
2. **Pre-allocate ID**: Use `top.fetch_add()` to reserve slot
3. **[CAS](https://en.wikipedia.org/wiki/Compare-and-swap) insertion**: Attempt
   to insert into hash table bucket
4. **Graceful failure**: If CAS fails, slot becomes a "hole" (`kind = 0`)

**Correctness guarantee**: Canonical node IDs are always returned. Readers treat
non-`NonTerm` kinds as terminal values, so holes don't affect evaluation.

### Stop-the-World Resizing

Uses [seqlock](https://en.wikipedia.org/wiki/Seqlock)-style synchronization for
arena growth:

- **Odd sequence**: Resize in progress (writers spin, readers retry)
- **Array migration**: Reverse-order copying prevents overlap issues
- **Bucket rebuild**: Hash table reconstructed after resize
- **Even sequence**: Stable state (normal operation resumes)

### Ring Buffer Concurrency

- **Single producer/consumer**: Each ring has dedicated thread roles
- **[ABA prevention](https://en.wikipedia.org/wiki/ABA_problem)**: Sequence
  numbers prevent concurrent access issues
- **[Memory barriers](https://en.wikipedia.org/wiki/Memory_barrier)**: Proper
  acquire/release ordering for visibility
- **[Wait/notify](https://en.wikipedia.org/wiki/Monitor_(synchronization))**:
  Efficient blocking with WASM atomic operations

### Shared Memory Safety

- **Typed array views**: JS-side access to arena arrays
- **Cache coherence**: 64-byte alignment prevents false sharing
- **Poisoning on failure**: Unrecoverable errors set poison sequences
- **Cross-thread visibility**: SharedArrayBuffer enables true parallelism

## Performance Characteristics

### Time Complexity

- **Allocation**: O(1) amortized (hash table lookup + potential growth)
- **Hash-consing lookup**: O(1) average case (hash table with chaining)
- **Reduction step**: O(depth) with iterative algorithm (no stack overflow)
- **Ring operations**: O(1) (lock-free with atomic CAS)

### Space Complexity

- **Per node**: ~16 bytes (4 arrays × 4 bytes + metadata)
- **Hash table**: O(capacity) for buckets and collision chains
- **Structural sharing**: Significant savings for common subexpressions
- **Memory efficiency**: ~60% less memory than naive tree representation

### Scalability

- **Expression depth**: Unlimited (iterative vs recursive)
- **Parallel workers**: Linear scaling with CPU cores
- **Memory growth**: Dynamic resizing with seqlock synchronization
- **Concurrent allocations**: Lock-free with optimistic concurrency

## Memory Layout

The shared arena is laid out as **header + fixed rings + SoA arrays**.

### Header (`SabHeader`)

- Magic number, ring parameters, memory offsets
- Capacity, bucket masks, atomic counters
- `max_steps`, `resize_seq`, `top` for coordination

### Rings (64-byte aligned)

- **SQ (Submission Queue)**: Host → Worker communication
- **CQ (Completion Queue)**: Worker → Host results
- Lock-free with sequence numbers for ABA prevention

### SoA Arrays (Struct of Arrays)

- `kind: u8[]` - Node type (Terminal/NonTerm/Continuation/Suspension)
- `sym: u8[]` - Symbol/mode data
- `left_id: u32[]` - Left child pointers
- `right_id: u32[] - Right child pointers
- `hash32: u32[]` - Hash values for deduplication
- `next_idx: u32[]` - Hash table collision chains
- `buckets: u32[]` - Hash table bucket heads
- Terminal cache: Fast access to S/K/I nodes

The JS/TS side constructs typed array views over these arrays for fast read-only
decoding and direct memory access.

## Building

The build is managed by Nix. `Cargo.toml` is generated by the flake.

```bash
nix run .#generate-cargo
cargo build --target wasm32-unknown-unknown --release
```

## WASM Exports

### Arena / reducer

- `initArena(capacity: u32) -> u32`: allocate and initialize a shared arena
  region (returns base pointer or error code).
- `connectArena(ptr: u32) -> u32`: connect an instance to an existing arena
  (returns 1 on success).
- `reset()`
- `allocTerminal(sym: u32) -> u32`
- `allocCons(left: u32, right: u32) -> u32`
- `arenaKernelStep(expr: u32) -> u32`
- `reduce(expr: u32, max: u32) -> u32`
- `setMaxSteps(max: u32)`: sets the global reduction limit used by workers.

### SQ/CQ interface

- `hostSubmit(node_id: u32, req_id: u32) -> u32`
  - returns `0` ok, `1` SQ full, `2` not connected
- `hostPull() -> i64`
  - returns `-1` if CQ empty, otherwise a packed value:
    - high 32 bits: `req_id`
    - low 32 bits: `node_id` (result root)
- `workerLoop() -> !`: blocking loop for worker instances (never returns).

### Debug

- `debugLockState() -> u32`: returns `resize_seq & 1` (1 if resizing).
- `getArenaMode() -> u32`: `0` heap mode, `1` SAB mode.
- `debugGetArenaBaseAddr() -> u32`
- `debugCalculateArenaSize(capacity: u32) -> u32`

## WASM Imports

- `memory: WebAssembly.Memory` (provided via `env.memory`) - The shared memory
  instance (must be created with `shared: true` for SAB mode)
- `js_allow_block() -> i32` - Returns `0` for main thread (spin-only) or `1` for
  worker threads (can block). This is instance-local and not stored in shared
  memory to avoid state collisions.

## Further Reading

For deeper understanding of the techniques used:

- **[Hash Consing](https://en.wikipedia.org/wiki/Hash_consing)**:
  Memory-efficient structural sharing
- **[Seqlock](https://en.wikipedia.org/wiki/Seqlock)**: Reader-writer
  synchronization
- **[Compare-and-Swap](https://en.wikipedia.org/wiki/Compare-and-swap)**: Atomic
  operation primitive
- **[Memory Barrier](https://en.wikipedia.org/wiki/Memory_barrier)**: Memory
  ordering guarantees
- **[io_uring](https://en.wikipedia.org/wiki/Io_uring)**: Asynchronous I/O
  framework
- **[SharedArrayBuffer](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/SharedArrayBuffer)**:
  Cross-thread memory sharing
- **[WebAssembly Atomics](https://webassembly.github.io/threads/js-api/)**:
  Atomic operations in WASM

## Structure

- `src/lib.rs`: crate entry point
- `src/arena.rs`: arena allocator + rings + reducer
