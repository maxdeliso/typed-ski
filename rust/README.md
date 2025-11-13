# typed-ski Rust Core

This directory contains the Rust implementation of the SKI combinator calculus
evaluator.

## Overview

The Rust code is compiled to WebAssembly and used by the TypeScript/Deno
library. It replaces the previous AssemblyScript implementation with better
performance and type safety.

## Structure

- `src/lib.rs` - Library entry point
- `src/arena.rs` - Arena-based SKI evaluator with hash-consing

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
