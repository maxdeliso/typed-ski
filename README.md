# SKI in TS

An implementation of a parser, evaluator, printer, and visualizer for
[SKI](https://en.wikipedia.org/wiki/SKI_combinator_calculus).

## Project Dependencies

- [TypeScript](https://www.typescriptlang.org/)
- [Deno](https://deno.com/)
- [AssemblyScript](https://www.assemblyscript.org/)

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

## Development Tasks

This project uses Deno's built-in task runner for standardized development
workflows:

### Building

Build AssemblyScript WebAssembly modules:

```bash
# Build both debug and release versions
deno task build

# Build individual versions
deno task build:debug
deno task build:release
```

### Testing

Run the test suite:

```bash
# Run tests only
deno task test

# Run full CI pipeline (build + test)
deno task ci
```

### Available Tasks

- `build` - Build both debug and release AssemblyScript modules
- `build:debug` - Build debug version only
- `build:release` - Build release version only
- `test` - Run the test suite
- `ci` - Run full CI pipeline (build then test)

## Interactive Development

You can experiment with the library interactively using Deno's REPL:

```bash
deno repl --allow-read
```

### Quick Start

```ts
import {
  parseSKI,
  prettyPrintSKIExpression,
  symbolicEvaluator,
} from "jsr:@maxdeliso/typed-ski";

const expr = parseSKI("(K S) I");
const result = symbolicEvaluator.reduce(expr);
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

## Status

[![Deno CI](https://github.com/maxdeliso/typed-ski/actions/workflows/deno.yml/badge.svg?branch=main)](https://github.com/maxdeliso/typed-ski/actions/workflows/deno.yml)
[![COC](https://img.shields.io/badge/Contributor%20Covenant-2.1-4baaaa.svg)](CODE_OF_CONDUCT.md)
