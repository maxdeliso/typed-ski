# SKI in TS

An implementation of a parser, evaluator, printer, and visualizer for
[SKI](https://en.wikipedia.org/wiki/SKI_combinator_calculus).

## Project Dependencies

- [TypeScript](https://www.typescriptlang.org/)
- [Deno](https://deno.com/)
- [Rust](https://www.rust-lang.org/) (compiled to WebAssembly)
- [Nix](https://nixos.org/) (build orchestration)

## Quick Start

This project uses a Makefile for common development tasks:

```bash
make setup  # Install necessary tools (Nix, configure experimental features)
make build  # Compile all artifacts (WASM, TypeScript, dist files)
make test   # Run the complete test suite (Rust + Deno tests, linting, formatting)
```

For detailed information about what each target does, see the
[Makefile](Makefile) or run `make help`.

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
3. Run `make setup` to install and configure Nix
4. Open the project in VS Code - the workspace settings will automatically apply

## Artifacts

- [JSR](https://jsr.io/@maxdeliso/typed-ski)
- [Crates.io](https://crates.io/crates/typed-ski)

## Build System

This project uses **Nix** for reproducible builds and version management. The
build system orchestrates Rust → WASM → TypeScript builds with a single source
of truth for versioning.

**Note:** The `nixpkgs` input tracks `nixos-unstable` branch, with the exact
commit pinned in `flake.lock` for reproducibility. To update to a newer nixpkgs
revision, run `nix flake update`.

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

GitHub Actions use the Makefile targets for building and testing. See the
workflow files in `.github/workflows/` for details.

## Status

[![Deno CI](https://github.com/maxdeliso/typed-ski/actions/workflows/deno.yml/badge.svg?branch=main)](https://github.com/maxdeliso/typed-ski/actions/workflows/deno.yml)
[![COC](https://img.shields.io/badge/Contributor%20Covenant-2.1-4baaaa.svg)](CODE_OF_CONDUCT.md)
