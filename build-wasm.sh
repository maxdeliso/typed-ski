#!/usr/bin/env bash
# Build script for generating WASM from Rust

set -euo pipefail

cd rust

echo "Building WASM (debug)..."
cargo build --target wasm32-unknown-unknown --lib

echo "Building WASM (release)..."
cargo build --release --target wasm32-unknown-unknown --lib

echo "Copying WASM files to wasm/..."
mkdir -p ../wasm
cp target/wasm32-unknown-unknown/debug/typed_ski.wasm ../wasm/debug.wasm
cp target/wasm32-unknown-unknown/release/typed_ski.wasm ../wasm/release.wasm

echo "WASM build complete!"
echo "  Debug: wasm/debug.wasm"
echo "  Release: wasm/release.wasm"


