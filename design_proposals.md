# Design Proposals for Expressiveness and Succinctness in Trip

This document outlines three proposed design improvements to the Trip language parser, grammar, and development tools to reduce boilerplate and improve expressiveness.

---

## 1. Parser Upgrade: Monad-Aware `do` Blocks (Maybe Support)

### The Problem

Monadic binding (`<-`) in `do` blocks is currently hardcoded in [systemFTerm.ts](file:///c:/Users/me/src/typed-ski/lib/parser/systemFTerm.ts) to desugar to `Err` and `Ok` constructors (the `Result` monad). Writing monadic code over other optional types like `Maybe` requires either manually wrapping `Result` values or writing deep nested `match` cascades to chain lookups.

### Proposed Solution

Add parser support to inspect the literal spelling of the return type declared in the `do [Type]` header. If the return type is `Maybe T`, desugar the `<-` bind operator using `None` and `Some` constructors instead:

```typescript
// In lib/parser/systemFTerm.ts (desugar do steps)
if (isMaybeMonad) {
  currentTerm = {
    kind: "systemF-match",
    scrutinee: step.expr,
    returnType,
    arms: [
      { constructorName: "None", params: [], body: mkSystemFVar("None") },
      { constructorName: "Some", params: [step.name], body: currentTerm },
    ],
  };
}
```

### Impact

Allows writing concise lookups and operations returning `Maybe`, avoiding nested pattern matching:

```trip
do [Maybe DefinitionInfo] {
  modInfo <- lookupModule modName (moduleEnvMods env)
  lookupDefinition modName symName (moduleInfoDefs modInfo)
}
```

---

## 2. Grammar Addition: Native `if-then-else` Syntactic Sugar

### The Problem

Because Trip is strict, execution branches must be thunked using explicit lambda parameters (`\u : U8 => ...`) and applied to the `if` combinator to achieve lazy evaluation. This makes simple conditions verbose and noisy:

```trip
if [Bool] condition (\u : U8 => thenBody) (\u : U8 => elseBody)
```

### Proposed Solution

Support native `if-then-else` syntax in the parser:

```trip
if [Bool] condition then thenBody else elseBody
```

The parser will desugar this directly into the existing delayed/thunked application of the `if` combinator.

### Impact

Significantly improves readability for single-condition branching, matching standard functional programming idioms.

---

## 3. Improvize Linter Rule: `trip-single-if-to-cond` Rewrite

### The Problem

Currently, the `trip-degenerate-if` linter rule inside [index.ts](file:///c:/Users/me/src/typed-ski/lib/improvize/index.ts) only groups and simplifies nested `if` chains into a `cond` block if there are two or more branches (`arms.length >= 2`).

### Proposed Solution

Relax this constraint or add a rule (`trip-single-if-to-cond`) that simplifies even single `if` expressions using thunks:

```trip
if [Maybe U8] (eqListU8 hQName qName)
  (\u : U8 => Some [U8] hId)
  (\u : U8 => findDataTypeId qName t)
```

Into a single-branch `cond` block (which already avoids lambda thunk boilerplate at the type level):

```trip
cond [Maybe U8] {
  | eqListU8 hQName qName => Some [U8] hId
  | otherwise => findDataTypeId qName t
}
```

### Impact

Enables the linter / formatter to clean up single `if` statements into `cond` blocks immediately, removing boilerplate from the existing codebase without requiring any compiler or grammar changes.
