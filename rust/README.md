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
  spinlocks for thread safety

Hash consing is implemented using a hash table with chaining, ensuring that
expressions with the same structure (same left and right children) are
automatically deduplicated. The arena can grow dynamically up to a fixed maximum
capacity.

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

- `initArena(capacity: u32) -> u32` - Initialize arena with specified capacity
- `connectArena(ptr: u32) -> u32` - Connect to existing SharedArrayBuffer arena
- `kindOf(n: u32) -> u32` - Get node kind
- `symOf(n: u32) -> u32` - Get terminal symbol
- `leftOf(n: u32) -> u32` - Get left child
- `rightOf(n: u32) -> u32` - Get right child
- `reset()` - Reset arena state
- `allocTerminal(sym: u32) -> u32` - Allocate terminal node
- `allocCons(left: u32, right: u32) -> u32` - Allocate cons cell
- `arenaKernelStep(expr: u32) -> u32` - Perform one reduction step
- `reduce(expr: u32, max: u32) -> u32` - Reduce to normal form

## Publishing

The Rust crate is published to crates.io alongside the JSR package.
