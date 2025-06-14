# SKI in TS

An implementation of a parser, evaluator, printer, and visualizer for
[SKI](https://en.wikipedia.org/wiki/SKI_combinator_calculus).

## Project Dependencies

* [TypeScript](https://www.typescriptlang.org/)
* [Deno](https://deno.com/)
* [AssemblyScript](https://www.assemblyscript.org/)

## Artifacts

* [JSR](https://jsr.io/@maxdeliso/typed-ski)

## Testing

Run the test suite:

```bash
deno run --allow-read --allow-run scripts/test.ts
```

## Works Referenced

### Books

* [Combinators: A Centennial View, Stephen Wolfram](https://www.amazon.com/dp/1579550436)
* [To Mock a Mockingbird, Raymond Smullyan](https://www.amazon.com/dp/0192801422)
* [Combinatory Logic Volume I, Haskell Brooks Curry & Robert Feys](https://www.amazon.com/dp/B0041N5RDC)

### Papers

* D. A. Turner, "A new implementation technique for applicative languages,"
  _Software: Practice and Experience_, vol. 9, no. 1, pp. 31-49, 1979. DOI:
  10.1002/spe.4380090105
* W. Stoye, T. J. W. Clarke, and A. C. Norman, "Some practical methods for rapid
  combinator reduction," in _Proceedings of the 1984 ACM Symposium on LISP and
  Functional Programming_ (LFP '84), ACM, New York, NY, USA, pp. 159-166, 1984.
  DOI: 10.1145/800055.802038
* H. G. Baker, "CONS should not CONS its arguments, or, a lazy alloc is a smart
  alloc," _ACM SIGPLAN Notices_, vol. 27, no. 3, pp. 24-34, 1992. DOI:
  10.1145/130854.130858

## Status

[![Deno CI](https://github.com/maxdeliso/typed-ski/actions/workflows/deno.yml/badge.svg?branch=main)](https://github.com/maxdeliso/typed-ski/actions/workflows/deno.yml)
[![COC](https://img.shields.io/badge/Contributor%20Covenant-2.1-4baaaa.svg)](CODE_OF_CONDUCT.md)
