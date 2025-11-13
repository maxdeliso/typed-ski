# SKI in TS

An implementation of a parser, evaluator, printer, and visualizer for
[SKI](https://en.wikipedia.org/wiki/SKI_combinator_calculus).

## Project Dependencies

- [TypeScript](https://www.typescriptlang.org/)
- [Deno](https://deno.com/)
- [Rust](https://www.rust-lang.org/) (compiled to WebAssembly)
- [Nix](https://nixos.org/) (build orchestration)

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

1. Install the Deno extension in VS Code
2. Clone the repository
3. Open the project in VS Code - the workspace settings will automatically apply

## Artifacts

- [JSR](https://jsr.io/@maxdeliso/typed-ski)

## Build System

This project uses **Nix** for reproducible builds and version management. The
build system orchestrates Rust → WASM → TypeScript builds with a single source
of truth for versioning.

**Note:** The `nixpkgs` input tracks `nixos-unstable` branch, with the exact
commit pinned in `flake.lock` for reproducibility. To update to a newer nixpkgs
revision, run `nix flake update`.

### Quick Start with Nix

**Build everything:**

```bash
nix build --extra-experimental-features 'nix-command flakes'
```

**Enter development shell:**

```bash
nix develop --extra-experimental-features 'nix-command flakes'
```

**Run tests:**

```bash
nix run .#test --extra-experimental-features 'nix-command flakes'      # Deno tests
nix run .#test-rust --extra-experimental-features 'nix-command flakes'  # Rust unit tests
```

**Deno commands (using Nix-provided Deno):**

```bash
nix run .#fmt -- --check          # Check formatting
nix run .#lint                     # Run linter
nix run .#publish -- --dry-run     # Dry run publish
```

**Update version and generate Cargo.toml:**

```bash
nix run .#update-version --extra-experimental-features 'nix-command flakes'
nix run .#generate-cargo --extra-experimental-features 'nix-command flakes'
```

### Setting Up Nix

To avoid typing `--extra-experimental-features` every time, add to
`~/.config/nix/nix.conf`:

```
experimental-features = nix-command flakes
```

### Build Artifacts

After `nix build`, WASM files are available at:

- `result/wasm/debug.wasm` - Debug WASM (1.6MB)
- `result/wasm/release.wasm` - Release WASM (21KB)

To copy to source tree:

```bash
cp result/wasm/*.wasm wasm/
```

## Development Tasks

### Building

**With Deno (legacy):**

```bash
# Build both debug and release versions
deno task build

# Build individual versions
deno task build:debug
deno task build:release
```

> **Note:** For Nix builds, see the
> [Quick Start with Nix](#quick-start-with-nix) section above.

### Testing

**With Deno:**

```bash
# Run tests only
deno task test

# Run full CI pipeline (build + test)
deno task ci
```

> **Note:** For Nix testing, use `nix run .#test` (see
> [Quick Start with Nix](#quick-start-with-nix) above).

### Publishing (Dry Run)

**JSR (using Nix-provided Deno):**

```bash
nix run .#publish -- --dry-run --allow-dirty
```

**Crates.io:**

```bash
cd rust
cargo publish --dry-run --no-verify
```

### Available Tasks

- `build` - Build both debug and release WASM modules (Deno)
- `build:debug` - Build debug version only (Deno)
- `build:release` - Build release version only (Deno)
- `test` - Run the test suite
- `ci` - Run full CI pipeline (build then test)

### Embedding WASM for Bundles

The CLI bundle and compiled binaries load the arena evaluator from an embedded
WASM payload so they can run without filesystem or network access. After
building the Rust artifacts (e.g. via `nix build` or `deno task build`), update
the embedded module with:

```bash
deno run -A scripts/embed-wasm.ts
```

CI runs this script automatically, but local builds should run it whenever the
WASM artifacts change to keep `lib/evaluator/arenaWasm.embedded.ts` in sync.

## Interactive Development

You can experiment with the library interactively using Deno's REPL:

```bash
deno repl --allow-read
```

### Quick Start

```ts
import {
  arenaEvaluator,
  parseSKI,
  prettyPrintSKIExpression,
} from "jsr:@maxdeliso/typed-ski";

const expr = parseSKI("(K S) I");
const result = arenaEvaluator.reduce(expr);
console.log(prettyPrintSKIExpression(result)); // "S"
```

For a comprehensive library of curated examples, see the
[JSR module documentation](https://jsr.io/@maxdeliso/typed-ski).

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

## Troubleshooting

### Nix Issues

**"command not found: nix"**

```bash
. /nix/store/*/etc/profile.d/nix.sh
```

**"Git tree is dirty"** This is just a warning. The build will still work.

**"builder failed"** Check the full log:

```bash
nix-store -l /nix/store/*-typed-ski.drv
```

## CI/CD

GitHub Actions automatically:

1. Install Nix
2. Generate version files
3. Build Rust → WASM
4. Run tests
5. Publish to JSR and crates.io

## Status

[![Deno CI](https://github.com/maxdeliso/typed-ski/actions/workflows/deno.yml/badge.svg?branch=main)](https://github.com/maxdeliso/typed-ski/actions/workflows/deno.yml)
[![COC](https://img.shields.io/badge/Contributor%20Covenant-2.1-4baaaa.svg)](CODE_OF_CONDUCT.md)
