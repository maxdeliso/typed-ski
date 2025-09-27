/**
 * WebAssembly arena-based SKI evaluator.
 *
 * This module provides high-performance SKI combinator evaluation using WebAssembly.
 * It exports functions for memory management, tree operations, and SKI reduction
 * within a WebAssembly arena for optimal performance.
 *
 * @module
 */

export * from "./arena-evaluator";

// See https://www.assemblyscript.org/concepts.html#special-imports
function abort(a: i32, b: i32, c: i32, d: i32): void { }
