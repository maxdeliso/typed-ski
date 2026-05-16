# typed-ski

This repository contains four conceptually distinct things that share one
build system and one workspace:

1. **SKI calculus library** — parser, printer, Church encoding, and bracket
   abstraction for SKI combinator calculus. Stable. Library code lives in
   [`lib/ski/`](lib/ski/), [`lib/parser/`](lib/parser/),
   [`lib/conversion/`](lib/conversion/), [`lib/types/`](lib/types/),
   [`lib/terms/`](lib/terms/).
2. **Thanatos** — a native C11/pthreads parallel SKI reducer that talks to
   the TypeScript evaluator over an ASCII "topo-DAG" wire protocol. Research
   artifact. Runtime in [`runtime/thanatos/`](runtime/thanatos/), TS client
   in [`lib/evaluator/`](lib/evaluator/).
3. **TripLang compiler** — a small typed functional language (modules, ADTs,
   polymorphism) with two backends: a classical path that compiles to SKI
   and runs on Thanatos, and a native path that lowers through MiniCore →
   ANF → Block IR → LLVM IR → clang. The native path is the production
   direction. CLI in [`bin/tripc.ts`](bin/tripc.ts); pipeline documented in
   [`lib/minicore/README.md`](lib/minicore/README.md); native runtime in
   [`runtime/trip/`](runtime/trip/).
4. **Self-hosting bootstrap** — an in-progress re-implementation of the
   compiler in TripLang itself. `.trip` modules in
   [`lib/compiler/`](lib/compiler/) (lexer.trip, parser.trip, core.trip,
   lowering.trip, llvm.trip, etc.). Currently exercised only by a
   verification test, not by the build path.

## Quick Start

```bash
bazelisk build //:thanatos              # native SKI reducer
bazelisk test  //:native_tests          # C tests + end-to-end native trip
bazelisk test  //:node_tests            # TypeScript test suite
bazelisk run   //:dist                  # build distributable CLI artifacts
bazelisk run   //:ci                    # fmt + lint + typecheck + build + cov
```

Alternatively, use `pnpm` for distribution: `pnpm run dist`.

Bazelisk handles all toolchains hermetically — the pinned Node.js version is
downloaded into a local cache on first use (set `TYPED_SKI_NODE_TOOLCHAIN_DIR`
to control the cache location). The Zig-based C/C++ toolchain is fetched
automatically; no WSL, Nix, or MSVC required on Windows. macOS Apple Silicon
is supported (Intel macOS is not in the pinned toolchain set); install Xcode
Command Line Tools so `xcrun --show-sdk-path` can locate the macOS SDK.

If Bazelisk is installed as `bazel`, both names work identically. Version
pinned in `.bazelversion`.

## Development Setup

1. Install `Node.js` (any recent version — used only as a bootstrap shim;
   Bazelisk will then fetch the pinned version).
2. Install `pnpm` (`npm install -g pnpm`).
3. Install `Bazelisk`.
4. On macOS: `xcode-select --install`.
5. Clone the repo, `pnpm install`, `bazelisk build //:thanatos`,
   `bazelisk run //:dist`.

Helper scripts in [`scripts/`](scripts/) use the local `pnpm` pinned via
`node_modules/pnpm`.

## Running Tests

```bash
bazelisk test //:node_tests             # sharded Node.js test suite
bazelisk run  //:test                   # single-process workspace run
bazelisk test //:native_tests           # C tests
bazelisk build //:thanatos              # rebuild native binary
```

On Windows, pass `--enable_runfiles` to `bazelisk test //:node_tests` if your
Bazel setup does not expose a runfiles tree by default.

### Running a singular test

With Node directly:

```powershell
$env:THANATOS_BIN = "$(pwd)\bazel-bin\runtime\thanatos\thanatos.exe"
node --disable-warning=ExperimentalWarning --test-global-setup ts_out/test/globalSetup.js --test ts_out/test/path/to/test.js
```

With Bazel:

```bash
bazelisk test //:node_tests --test_arg=test/path/to/test.ts
bazelisk run  //:test -- test/path/to/test.ts
```

### Other useful commands

- `bazelisk run //:dist` — atomic validated build of CLI artifacts
- `bazelisk run //:build` — alias for `//:dist` that also verifies version
- `bazelisk run //:typecheck` — TypeScript type checking
- `bazelisk run //:coverage` — tests with coverage output
- `bazelisk run //:ci` — fmt, lint, typecheck, build, single cov-producing test pass
- `bazelisk run //:verify_version` — check the repo-pinned Node.js version

## Artifacts

- [JSR](https://jsr.io/@maxdeliso/typed-ski)

The public API is intentionally small — `compile`, `compileTripSourceToLlvm`,
the SKI utilities, System F utilities, the Thanatos client, and the module
providers. See [`lib/index.ts`](lib/index.ts) for the full surface. Other
internal modules (MiniCore IR, Bundle-v1 serialization, TripC object format,
TopoDagWire protocol) are importable from their specific paths but are not
part of the stable contract.

---

# The four things, in detail

## 1. SKI calculus library

The original purpose of this repo. Parser, printer, evaluator, bracket
abstraction (lambda → SKI), Church encoding. The public entry points are
listed in [`lib/index.ts`](lib/index.ts).

The Thanatos-backed evaluator uses a global hash-cons (in the Thanatos path)
so identical sub-expressions share memory, keeping the footprint of large
reductions bounded.

## 2. Thanatos (parallel SKI reducer)

Thanatos is the native C11/pthreads orchestrator for compute-heavy SKI
reductions. The TypeScript `ThanatosEvaluator` is a daemon forwarder: it
serializes SKI expressions to the topo-DAG wire format, submits them to a
running `thanatos` daemon, and decodes the response. Keeping reduction native
avoids JS runtime overhead.

Sources: [`runtime/thanatos/`](runtime/thanatos/) (C),
[`lib/evaluator/`](lib/evaluator/) (TS),
[`lib/ski/topoDagWire.ts`](lib/ski/topoDagWire.ts) (protocol).

### Topo-DAG wire format

The TypeScript evaluator and Thanatos communicate using **Topo-DAG**, an
ASCII serialization of the SKI graph. Fixed-width records (19 chars per
record, 20-char stride including separator), separated by `|`. Each record
encodes one DAG node:

```text
[Term: 3 chars][Left Pointer: 8 hex chars][Right Pointer: 8 hex chars]
```

- **Term field (3 chars):** `@00` for application; `U` followed by 2 hex
  digits for unsigned 8-bit integers (e.g. `UFF`); terminal symbol followed
  by `00` (e.g. `S00`, `K00`, `I00`).
- **Left/right pointers (8 chars each):** zero-padded uppercase hex,
  absolute character offset of the child record. The DAG is topologically
  sorted so pointers strictly point backward. Null pointer is `FFFFFFFF`
  (used by leaves).

Roots are implicitly the last records in the string.

## 3. TripLang compiler

A small typed functional language. Two backends:

- **Native (LLVM)** — the production direction. Source flows through
  `TripLang AST → MiniCore → ANF → Block IR → LLVM IR → clang`. Pipeline
  documented in detail in [`lib/minicore/README.md`](lib/minicore/README.md).
- **Classical (SKI)** — Source flows through System F elaboration →
  typechecking → bracket abstraction → SKI → Thanatos.

CLI: [`bin/tripc.ts`](bin/tripc.ts) supports compilation (`tripc input.trip
[output.tripc]`), linking (`tripc --link a.tripc b.tripc`), LLVM emission
(`tripc --emit llvm input.trip`), and bundle parsing.

### Canonicalization

Compiler artifacts are canonical, ASCII-only outputs to support
reproducible builds and byte-level diffing:

- Top-level Trip unparse preserves the original source-level definition
  kind (`poly rec`, `combinator`, etc.) and emits parseable canonical
  syntax. Internal lowering stages use `lambda` during linking and
  execution.
- `.tripc` object files are emitted with canonical import/export/definition
  ordering and recursively sorted object keys.
- Link-time dependency traversal and SCC processing use explicit ASCII
  ordering rather than incidental `Map`/`Set` iteration order.
- Final SKI output is the fully parenthesized canonical `unparseSKI` form
  and should be compared as UTF-8 bytes.

### MiniCore ANF

Strict, backend-oriented A-normal form over MiniCore. Names every
non-atomic operand left-to-right before calls, primitive operations,
constructor applications, and case dispatch. Feeds Block IR; the SKI path
remains the lazy reference-oriented route.

ANF currently supports only direct known-symbol calls. Higher-order or
closure calls will need an explicit later representation (e.g. a separate
closure-call node after closure conversion). MiniCore and ANF `LocalId`s
are unique within a function; source-level shadowing is handled before ANF.

ANF nodes themselves stay compact and shape-preserving. `MiniCoreMetadata`
carries the typed context downstream passes need: function signatures,
primitive signatures and effects, constructor-family metadata, per-function
local types. ANF conversion records types for generated temporaries; ANF
validation uses the metadata to check case scrutinees, constructor
families, binder field types, and branch result types. Block IR therefore
consumes ANF as a typed source without first lowering ADTs to tags,
switches, or concrete data layouts.

### MiniCore Block IR

Backend-neutral typed control-flow contract after ANF. Keeps Trip-level
`MiniType`s, explicit basic blocks, block parameters for join values,
typed value references, effect-tagged instructions, and explicit
terminators. `BlockModule` requires `MiniCoreMetadata`; symbol summaries
in the block module are not authoritative unless they agree with the
metadata. Block function visibility derives from
`MiniCoreMetadata.exportedSymbols`, which MiniCore module lowering fills
from Trip `export` declarations.

Block IR keeps local definitions explicit. Function params, block params,
and instruction results define locals; when a value is needed in a
successor block, the terminator passes the source value to a target block
param. Captured values use fresh target params, preserving explicit
control-flow transfer without reusing a source local id as a second
definition.

The core instruction surface distinguishes pure Trip primitives, direct
Trip calls, backend runtime calls, high-level constructor creation, and
moves. Runtime calls use a small compiler-facing ABI, currently
`trip_read_one : () -> U8` and `trip_write_one : U8 -> Unit`. General ADT
`case` stays high-level in Block IR so later representation passes can
choose an implementation layout.

### LLVM backend

The compiler's ahead-of-time LLVM backend lowers MiniCore Block IR
modules into LLVM IR via `emitLlvmModule`. Supports generating generic
LLVM IR as well as compiling for specific target profiles
(`x86_64-unknown-linux-gnu`, `arm64-apple-darwin`,
`x86_64-pc-windows-msvc`). The emitted LLVM uses a boxed-runtime
representation to bridge Trip's data structures and semantics into native
machine code.

#### Native-v1 bootstrap contract

The first self-hosting LLVM target consumes a deterministic `bundle-v1`
source bundle, lowers the entry module through MiniCore/ANF/Block IR, and
emits LLVM IR to stdout. External LLVM tooling assembles and links.

`bundle-v1` is an ASCII, byte-length-delimited source format with an entry
module, target triple, main-wrapper kind, and module records sorted by
ASCII module name. Parsing is byte-exact: non-ASCII source bytes,
non-canonical module order, and any trailing byte are rejected.
Intentionally avoids JSON so a first-order Trip implementation can decode
with byte-list parsing.

Canonical byte layout:

```text
TRIP-BUNDLE-V1\n
entry <ModuleName>\n
target <TargetKind>\n
wrapper <WrapperKind>\n
modules <DecimalCount>\n
module <ModuleName> <DecimalByteLength>\n
<exact source bytes>
```

Additional modules repeat the `module` header and source byte payload,
with one newline between records. The final source byte is the final byte
of the bundle. `ModuleName` is `[A-Za-z_][A-Za-z0-9_]*`; decimal counts
and lengths are base-10 safe integers with no leading zero (except `0`).
Supported bundle targets: `generic`, `x86_64-unknown-linux-gnu`,
`arm64-apple-darwin`, `x86_64-pc-windows-msvc`. Supported wrappers:
`none`, `enabled`.

`target datalayout` is not yet part of `bundle-v1`. When it is added,
native-v1 must carry it explicitly in the bundle contract rather than
inferring layout from the host.

The LLVM source path validates the native-v1 subset before emission.
Runtime function values, escaping lambdas, function-typed constructor
fields, dynamic callees, and unsupported higher-order values are rejected
before Block IR / LLVM. The object language may still contain System F
terms and lambdas; the compiler implementation must represent and
transform them as first-order AST data.

### TripC object files (`.tripc`)

A JSON-based intermediate object file format for modular compilation and
linking. A `.tripc` object encapsulates a compiled Trip module:

- **Module identity and linkage** — module name, `exports`, explicit
  `imports` mapping symbols to providing modules.
- **Definitions** — compiled intermediate definitions (AST
  representations) indexed by symbol name.
- **Data definitions** — canonicalized ADT metadata, allowing downstream
  passes to canonicalize and validate matches across module boundaries
  without relying on hardcoded built-ins.

`.tripc` serialization forces reproducible canonical ASCII-ordered keys
and safely encapsulates large numeric types using a dedicated
`__trip_bigint__` representation.

> The `.tripc` and `bundle-v1` formats currently coexist. A consolidation
> is planned — see [`docs/design/`](docs/design/) for in-progress design
> notes.

## 4. Self-hosting bootstrap

`.trip` files under [`lib/compiler/`](lib/compiler/) (lexer.trip,
parser.trip, core.trip, lowering.trip, llvm.trip, moduleEnv.trip, etc.)
are an in-progress re-implementation of the compiler in TripLang itself.
They are not currently part of the main build — they are exercised only by
a `bootstrappedCompile` verification test that checks the self-hosted
output matches the TypeScript compiler.

This is aspirational code targeting LLVM IR self-hosting (not in-language
object emission or linking). When the bootstrap matures, it will compile
through the `bundle-v1` contract above. Parser bootstrap progress is
measured through that contract; legacy Thanatos/SKI parser bootstrap tests
are not acceptance criteria for this milestone.

---

# Build system

Bazel is the primary build entrypoint. The supported workflow is Bazel
plus Node.js, with generated metadata, packaging, linting, coverage, and
the test suite exposed through Bazel commands.

# Works referenced

## Books

- [Combinators: A Centennial View, Stephen Wolfram](https://www.amazon.com/dp/1579550436)
- [To Mock a Mockingbird, Raymond Smullyan](https://www.amazon.com/dp/0192801422)
- [Combinatory Logic Volume I, Haskell Brooks Curry & Robert Feys](https://www.amazon.com/dp/B0041N5RDC)

## Papers

- D. A. Turner, "A new implementation technique for applicative languages,"
  _Software: Practice and Experience_, vol. 9, no. 1, pp. 31–49, 1979.
  DOI: 10.1002/spe.4380090105
- W. Stoye, T. J. W. Clarke, and A. C. Norman, "Some practical methods for
  rapid combinator reduction," in _Proceedings of the 1984 ACM Symposium
  on LISP and Functional Programming_ (LFP '84), ACM, New York, NY, USA,
  pp. 159–166, 1984. DOI: 10.1145/800055.802038
- H. G. Baker, "CONS should not CONS its arguments, or, a lazy alloc is a
  smart alloc," _ACM SIGPLAN Notices_, vol. 27, no. 3, pp. 24–34, 1992.
  DOI: 10.1145/130854.130858
- C. Flanagan, A. Sabry, B. F. Duba, and M. Felleisen, "The essence of
  compiling with continuations," in _Proceedings of the ACM SIGPLAN 1993
  Conference on Programming Language Design and Implementation_ (PLDI '93),
  ACM, New York, NY, USA, pp. 237–247, 1993. DOI: 10.1145/155090.155113

# CI/CD

GitHub Actions use Bazel on Ubuntu, native Windows, and macOS Apple Silicon.
Native C targets run through ordinary Bazel build/test steps. The Node.js
suite runs through the sharded `//:node_tests` Bazel test target so each
shard owns its own Thanatos session. The hosted macOS runner includes
Xcode tooling and the macOS SDK; local macOS setups need Xcode Command
Line Tools installed. See the workflow files in `.github/workflows/`.

# Status

[![Bazel CI](https://github.com/maxdeliso/typed-ski/actions/workflows/node.yml/badge.svg)](https://github.com/maxdeliso/typed-ski/actions/workflows/node.yml)
[![COC](https://img.shields.io/badge/Contributor%20Covenant-2.1-4baaaa.svg)](CODE_OF_CONDUCT.md)
