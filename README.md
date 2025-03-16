# SKI in TS

An implementation of a parser, evaluator, printer, and visualizer for the [SKI](https://en.wikipedia.org/wiki/SKI_combinator_calculus) combinators in [TypeScript](https://www.typescriptlang.org/).

## Running

In the checkout directory:

```bash
yarn install
yarn build
yarn ski
```

## Testing

Run the test suite:

```bash
yarn test
```

### Test Coverage

Generate test coverage report:

```bash
# Generate text-only coverage report
yarn test:coverage

# Generate HTML coverage report (available in the coverage/ directory)
yarn test:coverage:report
```

## Books

* [Combinators: A Centennial View, Stephen Wolfram](https://www.amazon.com/dp/1579550436)
* [To Mock a Mockingbird, Raymond Smullyan](https://www.amazon.com/dp/0192801422)
* [Combinatory Logic Volume I, Haskell Brooks Curry & Robert Feys](https://www.amazon.com/dp/B0041N5RDC)

## Papers

* D. A. Turner, "A new implementation technique for applicative languages," Software: Practice and Experience, vol. 9, no. 1, pp. 31-49, 1979. DOI: 10.1002/spe.4380090105
* W. Stoye, T. J. W. Clarke, and A. C. Norman, "Some practical methods for rapid combinator reduction," in Proceedings of the 1984 ACM Symposium on LISP and functional programming (LFP '84), ACM, New York, NY, USA, pp. 159-166, 1984. DOI: 10.1145/800055.802038

## Status

[![Node.js CI](https://github.com/maxdeliso/typed-ski/actions/workflows/node.js.yml/badge.svg?branch=main)](https://github.com/maxdeliso/typed-ski/actions/workflows/node.js.yml)
[![COC](https://img.shields.io/badge/Contributor%20Covenant-2.1-4baaaa.svg)](CODE_OF_CONDUCT.md)
