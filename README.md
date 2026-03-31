# SKI in TS

An implementation of a parser, evaluator, printer, and visualizer for
[SKI](https://en.wikipedia.org/wiki/SKI_combinator_calculus).

## Project Dependencies

- [TypeScript](https://www.typescriptlang.org/)
- [Deno](https://deno.com/) as a bootstrap for the repo-pinned toolchain in
  `deno.jsonc`
- [C](https://en.wikipedia.org/wiki/C_(programming_language)) (compiled to
  WebAssembly)
- [Bazelisk](https://github.com/bazelbuild/bazelisk), which downloads the
  hermetic Zig-based C/C++ toolchain on first native build

## Quick Start

This project uses Bazelisk for common development tasks:

```bash
bazelisk build //:thanatos //:release_wasm
bazelisk test //:native_tests
bazelisk run //:build
bazelisk run //:test
bazelisk run //:coverage
bazelisk run //:ci
bazelisk run //:serve_hephaestus
bazelisk run //:vs_project
```

The Bazel graph now includes hermetic native `thanatos` and `wasm/release.wasm`
targets alongside the Deno-based build, lint, coverage, and packaging flows,
without requiring WSL, Nix, or Visual Studio Build Tools on Windows.

If Bazelisk is installed as `bazel` on your machine, the same commands work with
`bazel` in place of `bazelisk`. The Bazel version is pinned in `.bazelversion`.

## Development Setup

### VS Code Extensions

This project includes VS Code workspace settings that require the following
extensions:

- **[Deno](https://marketplace.visualstudio.com/items?itemName=denoland.vscode-deno)** -
  Official Deno extension for TypeScript support, linting, and IntelliSense

The `.vscode/settings.json` file configures:

- Enables the Deno extension for this workspace
- Disables the built-in TypeScript language server to avoid conflicts
- Configures Deno linting and import suggestions

### Installation

1. Install `Deno`
2. Install `Bazelisk`
3. Clone the repository
4. Run `bazelisk build //:thanatos //:release_wasm`
5. Run `bazelisk run //:build`
6. Open the project in VS Code and install the Deno extension if you want IDE
   support

The required Deno toolchain version is pinned in `deno.jsonc` under
`toolchain.deno`. Bazelisk commands use your installed Deno only as a bootstrap
shim, then run the repo-pinned Deno version for the actual build/test command.
If your system Deno does not match, the first Bazelisk run will install the
exact pinned binary into a local toolchain cache. Set
`TYPED_SKI_DENO_TOOLCHAIN_DIR` if you want that cache in a specific location.

### Running Tests

Run the portable test suite with:

```bash
bazelisk run //:test
```

Run the native C targets with:

```bash
bazelisk build //:thanatos //:release_wasm
bazelisk test //:native_tests
```

Check which repo-pinned Deno version Bazelisk will use with:

```bash
bazelisk run //:verify_version
```

Other useful commands:

- `bazelisk run //:build` builds generated metadata and distributable artifacts
- `bazelisk run //:coverage` runs the portable tests with coverage output
- `bazelisk run //:ci` runs the build, formatting, lint, tests, and coverage
  flow after native Bazel targets have been built
- `bazelisk run //:vs_project` writes `compile_commands.json`,
  `CppProperties.json`, `.vs/tasks.vs.json`, `.vs/launch.vs.json`,
  `typed-ski-thanatos.sln`, and `typed-ski-thanatos.vcxproj` for Visual Studio
  workflows

### Visual Studio

To generate Visual Studio Open Folder metadata from the Bazel C targets, run:

```powershell
bazelisk run //:vs_project
```

Then open the repository directory in Visual Studio with **File > Open >
Folder**. The generated metadata gives Visual Studio:

- `CppProperties.json` for Bazel-derived include paths and defines
- `.vs/tasks.vs.json` for Bazel build and test tasks
- `.vs/launch.vs.json` with a starter `thanatos` debug configuration
- `typed-ski-thanatos.sln` and `typed-ski-thanatos.vcxproj` for the classic
  solution/project workflow, including one project for `thanatos` and one for
  each native test target

The launch configuration uses `gdb` (`type: "cppdbg"`). If `gdb.exe` is not on
your `PATH`, edit `.vs/launch.vs.json` and set `miDebuggerPath` to your local
GDB installation before starting a debug session.

If you want the old-school Visual Studio debugger or profiler, open
`typed-ski-native.sln`. The generated projects are Makefile-style C++ projects:
Visual Studio invokes Bazel for build/rebuild/clean, and each startup project
launches its Bazel-built binary directly. The generated solution includes:

- `typed-ski-thanatos`
- `typed-ski-dag-codec-test`
- `typed-ski-performance-test`
- `typed-ski-session-test`
- `typed-ski-ski-io-test`
- `typed-ski-util-test`

The generated `typed-ski-performance-test` project includes a starter debugger
argument preset tuned for faster iteration inside Visual Studio. Edit the
project's Debugging properties if you want to switch back to a larger arena or
workload.

The generated Visual Studio metadata is local-only and gitignored, including
`compile_commands.json`, `CppProperties.json`, `.vs/`, `typed-ski-native.sln`,
`typed-ski-*.vcxproj`, `typed-ski-*.vcxproj.filters`, and
`*.vcxproj.user`. Regenerate them at any time with `bazelisk run //:vs_project`.

### Running Hephaestus

Build the browser assets for the workbench with:

```bash
bazelisk run //:hephaestus_assets
```

Start the server with:

```bash
bazelisk run //:serve_hephaestus
```

Then open `http://127.0.0.1:8080/workbench.html`.

To use a different port:

```bash
PORT=9000 bazelisk run //:serve_hephaestus
```

On PowerShell:

```powershell
$env:PORT = "9000"
bazelisk run //:serve_hephaestus
```

Notes:

- `//:serve_hephaestus` builds `dist/workbench.js`, `dist/webglForest.js`, and
  `dist/arenaWorker.js` before starting the server.
- `bazelisk build //:release_wasm` writes the hermetic wasm artifact to
  `bazel-bin/wasm/release.wasm`. The Deno-side build flow stages that artifact
  into `wasm/release.wasm` when present so browser and publish paths can use the
  Bazel-built module.

## Artifacts

- [JSR](https://jsr.io/@maxdeliso/typed-ski)

## Build System

This project uses **Bazel** as the primary build entrypoint. The supported
workflow for this branch is Bazel plus Deno, with generated metadata, packaging,
linting, coverage, and the portable test suite exposed through portable Bazel
commands.

## Canonicalization

The TypeScript bootstrap pipeline treats compiler artifacts as canonical,
ASCII-only outputs:

- Top-level Trip unparse preserves the original definition kind and emits
  parseable canonical syntax such as `poly rec`, `typed`, `untyped`, and
  `combinator`.
- `.tripc` object files are emitted with canonical import/export/definition
  ordering and recursively sorted object keys.
- Link-time dependency traversal and SCC processing use explicit ASCII ordering
  instead of incidental `Map`/`Set` iteration order.
- Final SKI output is the fully parenthesized canonical `unparseSKI` form and
  should be compared as UTF-8 bytes.

## Performance and Parallelism

This project implements a high-performance, multi-threaded SKI reducer:

- **Parallel Request Execution**: Multiple Web Workers reduce independent
  requests against a shared arena.
- **Preemptive Yielding**: Workers yield suspended computations so long-running
  jobs do not monopolize execution.
- **Lock-Free Communication**: io_uring-style submission and completion rings
  enable low-latency communication between the main thread and workers.
- **Structural Sharing**: Global hash-consing ensures that identical
  sub-expressions share the same memory, significantly reducing the memory
  footprint of large reductions.

### Thanatos (Native Orchestrator)

Thanatos is the native C11/pthreads orchestrator for compute-heavy reductions.
The same C core (arena and reduction logic) is compiled in two ways: as the
native `thanatos` binary for CLI/batch use, and to WebAssembly
(`wasm/release.wasm`) for use by the parallel arena evaluator in Deno. The
native binary keeps the SKI evaluator on-metal by managing worker dispatch and
completion queues directly, which avoids Deno/WASM bridge overhead and improves
throughput and runtime stability for long-running workloads.

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

## CI/CD

GitHub Actions use Bazel on both Ubuntu and native Windows. See the workflow
files in `.github/workflows/` for details.

## Status

[![Deno CI](https://github.com/maxdeliso/typed-ski/actions/workflows/deno.yml/badge.svg?branch=main)](https://github.com/maxdeliso/typed-ski/actions/workflows/deno.yml)
[![COC](https://img.shields.io/badge/Contributor%20Covenant-2.1-4baaaa.svg)](CODE_OF_CONDUCT.md)
