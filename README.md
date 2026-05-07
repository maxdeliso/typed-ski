# SKI in TS

An implementation of a parser, evaluator, printer, and visualizer for
[SKI](https://en.wikipedia.org/wiki/SKI_combinator_calculus).

## Project Dependencies

- [TypeScript](https://www.typescriptlang.org/)
- [pnpm](https://pnpm.io/) for dependency management (repo-pinned as a `devDependency`)
- [Node.js](https://nodejs.org/) as a bootstrap for the repo-pinned toolchain
- [C](<https://en.wikipedia.org/wiki/C_(programming_language)>) for the native
  Thanatos evaluator
- [Bazelisk](https://github.com/bazelbuild/bazelisk), which downloads the
  hermetic Zig-based C/C++ toolchain on first native build

## Quick Start

This project uses Bazelisk for common development tasks:

```bash
bazelisk build //:thanatos
bazelisk test //:native_tests
bazelisk test //:node_tests
bazelisk run //:dist
bazelisk run //:test
bazelisk run //:coverage
bazelisk run //:ci
```

Alternatively, use `pnpm` directly for common distribution tasks:

```bash
pnpm run dist
```

The Bazel graph includes a hermetic native `thanatos` target alongside the
Node.js-based build, lint, coverage, and packaging flows, without requiring WSL,
Nix, or Visual Studio Build Tools on Windows.

If Bazelisk is installed as `bazel` on your machine, the same commands work with
`bazel` in place of `bazelisk`. The Bazel version is pinned in `.bazelversion`.

## Development Setup

### Installation

1. Install `Node.js`
2. Install `pnpm` (system-wide or use `npm install -g pnpm`)
3. Install `Bazelisk`
4. Clone the repository
5. Run `pnpm install`
6. Run `bazelisk build //:thanatos`
7. Run `bazelisk run //:dist`
8. Open the project in VS Code

The required Node.js toolchain version is pinned in the repository configuration.
Bazelisk commands use your installed Node.js only as a bootstrap shim, then run
the repo-pinned Node.js version for the actual build/test command.
If your system Node.js does not match, the first Bazelisk run will install the
exact pinned binary into a local toolchain cache. Set
`TYPED_SKI_NODE_TOOLCHAIN_DIR` if you want that cache in a specific location.

This repository uses a local installation of `pnpm` pinned in `package.json`.
Helper scripts in `scripts/` automatically use the local `pnpm` binary found in
`node_modules/pnpm`.

### Running Tests

Run the test suite with:

```bash
bazelisk test //:node_tests
```

For a local single-process workspace run of the same Node.js suite, you can still
use:

```bash
bazelisk run //:test
```

On Windows, pass `--enable_runfiles` to `bazelisk test //:node_tests` if your
Bazel setup does not expose a runfiles tree by default.

Run the native C targets with:

```bash
bazelisk build //:thanatos
bazelisk test //:native_tests
```

#### Running Singular Tests

To run a single test file with Node directly:

```powershell
$env:THANATOS_BIN = "$(pwd)\bazel-bin\core\thanatos.exe"
node --experimental-transform-types --test-global-setup test/globalSetup.ts --test test/path/to/test.ts
```

To run a single test with Bazel:

```bash
bazelisk test //:node_tests --test_arg=test/path/to/test.ts
```

Or run a specific test by its full path:

```bash
bazelisk run //:test -- test/path/to/test.ts
```

Check which repo-pinned Node.js version Bazelisk will use with:

```bash
bazelisk run //:verify_version
```

Other useful commands:

- `bazelisk run //:dist` performs an atomic, validated build of distributable CLI artifacts
- `bazelisk run //:build` is an alias for `//:dist` that also verifies the repo version
- `bazelisk run //:typecheck` runs TypeScript type checking over the test suite
- `bazelisk run //:coverage` runs the tests with coverage output
- `bazelisk run //:ci` runs formatting, lint, type checking, build, and a single
  coverage-producing local test pass

## Artifacts

- [JSR](https://jsr.io/@maxdeliso/typed-ski)

## Build System

This project uses **Bazel** as the primary build entrypoint. The supported
workflow for this branch is Bazel plus Node.js, with generated metadata, packaging,
linting, coverage, and the test suite exposed through Bazel commands.

## Canonicalization

The TypeScript bootstrap pipeline treats compiler artifacts as canonical,
ASCII-only outputs:

- Top-level Trip unparse preserves the original source-level definition kind and
  emits parseable canonical syntax such as `poly rec` and `combinator`, while
  internal lowering stages use `lambda` during linking and execution.
- `.tripc` object files are emitted with canonical import/export/definition
  ordering and recursively sorted object keys.
- Link-time dependency traversal and SCC processing use explicit ASCII ordering
  instead of incidental `Map`/`Set` iteration order.
- Final SKI output is the fully parenthesized canonical `unparseSKI` form and
  should be compared as UTF-8 bytes.

## Performance and Parallelism

This project evaluates SKI expressions through Thanatos, a native
multi-threaded daemon:

- **Parallel Native Execution**: Thanatos dispatches reductions to native worker
  threads.
- **Daemon Delegation**: TypeScript evaluator APIs submit topo-DAG requests to
  the daemon and decode topo-DAG responses.
- **Structural Sharing**: Global hash-consing ensures that identical
  sub-expressions share the same memory, significantly reducing the memory
  footprint of large reductions.

### Thanatos (Native Orchestrator)

Thanatos is the native C11/pthreads orchestrator for compute-heavy reductions.
The TypeScript evaluator is a daemon forwarder: it serializes SKI expressions to
the topo-DAG wire format, submits requests to `thanatos`, and decodes the
daemon's response. Keeping evaluation native avoids JavaScript runtime overhead
and improves throughput and runtime stability for long-running workloads.

### Topo-DAG Wire Format

The TypeScript evaluator and Thanatos communicate using the **Topo-DAG** wire format, an ASCII-based serialization of the SKI graph. It's designed to be simple, fast to parse natively, and natively structural-sharing aware.

A Topo-DAG string consists of a series of fixed-width records separated by `|`. Each record is exactly 19 characters wide (making the stride 20 characters including the separator), and represents a single node in the DAG.

```text
[Term: 3 chars][Left Pointer: 8 hex chars][Right Pointer: 8 hex chars]
```

- **Term Field (3 chars)**:
  - Application nodes: `@00`
  - Unsigned 8-bit integers: `U` followed by a 2-character hex value (e.g., `UFF`).
  - Terminal symbols: The symbol character followed by `00` (e.g., `S00`, `K00`, `I00`).
- **Left/Right Pointers (8 chars each)**:
  - Encoded as 8-character, zero-padded uppercase hexadecimal strings.
  - Represent the **absolute character offset** of the child record within the string.
  - Because the DAG is topologically sorted, pointers strictly point **backwards** to previously defined records.
  - Null pointers (used by leaves like terminals and `U8`s) are represented by `FFFFFFFF`.

Because pointers point backward, the roots of the DAG are implicitly the last records in the string.

## MiniCore ANF

MiniCore ANF is a strict, backend-oriented normalization layer for the current
first-order MiniCore AST. It makes evaluation order explicit by naming
non-atomic operands left-to-right before calls, primitive operations,
constructor applications, and case dispatch. This is intended to feed Block IR;
the SKI path remains the lazy reference-oriented route.

ANF supports only direct known-symbol calls. Higher-order or closure calls will
need an explicit later representation, such as a separate closure-call node after
closure conversion support exists. MiniCore and ANF `LocalId`s are expected to
be unique within a function; source-level shadowing is handled before ANF.

The ANF nodes themselves stay compact and shape-preserving, while
`MiniCoreMetadata` carries the typed context needed by downstream passes:
function signatures, primitive signatures and effects, constructor-family
metadata, and per-function local types. ANF conversion records types for
generated temporaries, and ANF validation uses the metadata to check case
scrutinees, constructor families, binder field types, and branch result types.
Block IR can therefore consume ANF as a typed source without first lowering ADTs
to tags, switches, or concrete data layouts.

## MiniCore Block IR

MiniCore Block IR is the backend-neutral typed control-flow contract after ANF.
It keeps Trip-level `MiniType`s, explicit basic blocks, block parameters for
join values, typed value references, effect-tagged instructions, and explicit
terminators. It is intentionally not shaped around any specific backend.
`BlockModule` requires `MiniCoreMetadata`; symbol summaries in the block module
are not authoritative unless they agree with that metadata. Block function
visibility is derived from `MiniCoreMetadata.exportedSymbols`, which the
MiniCore module lowering fills from Trip `export` declarations.

Block IR keeps local definitions explicit. Function params, block params, and
instruction results define locals; when a value is needed in a successor block,
the terminator passes the source value to a target block param. Captured values
use fresh target params, which preserves explicit control-flow transfer without
reusing a source local id as a second definition.

The core instruction surface distinguishes pure Trip primitives, direct Trip
calls, backend runtime calls, high-level constructor creation, and moves.
Runtime calls use a small compiler-facing ABI, currently `trip_read_one : () ->
U8` and `trip_write_one : U8 -> Unit`. General ADT `case` also stays high-level
in Block IR, so later representation passes can choose an implementation layout.

## LLVM Compiler Backend

In addition to the Thanatos SKI evaluator, the compiler features an ahead-of-time **LLVM Backend**. The pipeline lowers MiniCore Block IR modules into LLVM IR via the `emitLlvmModule` target. This backend supports generating generic LLVM IR as well as compiling for specific target profiles (e.g., `x86_64-unknown-linux-gnu`, `wasm32-wasi`). The emitted LLVM code utilizes a boxed-runtime representation to bridge Trip's data structures and semantics into native machine code.

## TripC Object Files (`.tripc`)

The compiler uses a standardized JSON-based intermediate object file format (`.tripc`) for modular compilation and linking. A `.tripc` object encapsulates a compiled Trip module, carrying:

- **Module Identity & Linkage**: The module name, `exports`, and explicit `imports` mapping symbols to their providing modules.
- **Definitions**: The compiled intermediate definitions (AST representations) indexed by symbol name.
- **Data Definitions**: Canonicalized Abstract Data Type (ADT) metadata. This allows downstream compilation passes to robustly canonicalize and validate matches across module boundaries without relying on hardcoded built-ins.

To guarantee determinism, `.tripc` serialization forces reproducible, canonical ASCII-ordered keys and safely encapsulates large numeric types using a dedicated `__trip_bigint__` representation.

## Works Referenced

### Books

- [Combinators: A Centennial View, Stephen Wolfram](https://www.amazon.com/dp/1579550436)
- [To Mock a Mockingbird, Raymond Smullyan](https://www.amazon.com/dp/0192801422)
- [Combinatory Logic Volume I, Haskell Brooks Curry & Robert Feys](https://www.amazon.com/dp/B0041N5RDC)

### Papers

- D. A. Turner, "A new implementation technique for applicative languages,"
  _Software: Practice and Experience_, vol. 9, no. 1, pp. 31-49, 1979. DOI:
  10.1002/spe.4380090105
- W. Stoye, T. J. W. Clarke, and A. C. Norman, "Some practical methods for rapid
  combinator reduction," in _Proceedings of the 1984 ACM Symposium on LISP and
  Functional Programming_ (LFP '84), ACM, New York, NY, USA, pp. 159-166, 1984.
  DOI: 10.1145/800055.802038
- H. G. Baker, "CONS should not CONS its arguments, or, a lazy alloc is a smart
  alloc," _ACM SIGPLAN Notices_, vol. 27, no. 3, pp. 24-34, 1992. DOI:
  10.1145/130854.130858
- C. Flanagan, A. Sabry, B. F. Duba, and M. Felleisen, "The essence of
  compiling with continuations," in _Proceedings of the ACM SIGPLAN 1993
  Conference on Programming Language Design and Implementation_ (PLDI '93),
  ACM, New York, NY, USA, pp. 237-247, 1993. DOI: 10.1145/155090.155113

## CI/CD

GitHub Actions use Bazel on both Ubuntu and native Windows. Native C targets run
through ordinary Bazel build/test steps, and the Node.js suite runs through the
sharded `//:node_tests` Bazel test target so each shard owns its own Thanatos
session. See the workflow files in `.github/workflows/` for details.

## Status

[![Bazel CI](https://github.com/maxdeliso/typed-ski/actions/workflows/node.yml/badge.svg)](https://github.com/maxdeliso/typed-ski/actions/workflows/node.yml)
[![COC](https://img.shields.io/badge/Contributor%20Covenant-2.1-4baaaa.svg)](CODE_OF_CONDUCT.md)
