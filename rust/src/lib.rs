//! SKI Combinator Calculus Evaluator
//!
//! This module provides an arena-based evaluator for SKI combinator calculus,
//! compiled to WebAssembly for use in JavaScript/TypeScript environments.

#![no_std]
#![cfg_attr(target_arch = "wasm32", feature(stdarch_wasm_atomic_wait))]

// Minimal Panic Handler
#[cfg(not(test))]
#[panic_handler]
fn panic(_info: &core::panic::PanicInfo) -> ! {
    #[cfg(target_arch = "wasm32")]
    core::arch::wasm32::unreachable();
    #[cfg(not(target_arch = "wasm32"))]
    loop {}
}

pub mod arena;

pub use arena::*;

