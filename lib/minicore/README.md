# MiniCore

MiniCore is the typed, first-order IR that sits between the TripLang frontend
and the native (LLVM) backend. It is also a runnable interpreter, so any
MiniCore program can be evaluated directly without going through the rest of
the pipeline.

## Pipeline

The native compilation path is a four-stage lowering. Each stage has exactly
one canonical entry point.

```
TripLang AST ──► MiniCore Program ──► ANF Program ──► BlockModule ──► LLVM IR
                 (typed, first-order)  (linear)        (basic blocks)   (textual)
```

| Stage | Entry point                                                | File                                    |
|-------|------------------------------------------------------------|-----------------------------------------|
| 1     | `compileMiniCoreModules(modules, entry)`                   | [fromTrip.ts](fromTrip.ts)              |
| 2     | `toAnfProgram(program)`                                    | [toAnf.ts](toAnf.ts)                    |
| 3     | `anfToBlockModule(anfProgram)`                             | [fromAnf.ts](fromAnf.ts)                |
| 4     | `emitLlvmModule(blockModule, …)`                           | [../compiler/llvm/emitLlvm.ts](../compiler/llvm/emitLlvm.ts) |

The four stages live behind one driver, `compileTripSourceToLlvm`, in
[../compiler/llvmCompiler.ts](../compiler/llvmCompiler.ts).

## What each stage is

**Stage 1 — MiniCore Program** ([ast.ts](ast.ts)). High-level typed, first-order
representation: function definitions, constructor definitions, primitive
definitions, `let` bindings, `case` expressions, direct known-symbol calls,
constructor application. Tree-shaped expressions; evaluation order is implicit.
Carries `MiniCoreMetadata` with function signatures, primitive effect kinds,
and ADT family information.

**Stage 2 — ANF Program** ([anfAst.ts](anfAst.ts)). A-normal form: non-atomic
operands are named left-to-right before each call, primitive op, constructor
application, and case scrutinee. Evaluation order is explicit. Generated
temporaries have recorded types. Shape-preserving — ADTs, primitives, and
runtime calls are still represented at MiniCore-level granularity.

**Stage 3 — BlockModule** ([blockAst.ts](blockAst.ts)). Backend-neutral typed
control-flow contract: explicit basic blocks, block parameters for join
values, typed value references, effect-tagged instructions, explicit
terminators. Function/block params and instruction results define locals;
inter-block value transfer goes through terminator-supplied target params.
Still preserves MiniCore types and high-level `case` / `construct`
operations so a later representation pass can pick a layout.

**Stage 4 — LLVM IR**. Lowered through a boxed-runtime representation. The
generic profile is target-agnostic LLVM IR; named target profiles
(`x86_64-unknown-linux-gnu`, `arm64-apple-darwin`, `x86_64-pc-windows-msvc`)
fix the triple and datalayout for downstream tooling.

## Cross-stage utilities

- **Type-of**: [typeOf.ts](typeOf.ts) — `typeOfMiniCoreExpr`, `typeOfAnfExpr`,
  `typeOfAnfValue`, `typeOfAnfAtom`.
- **Validators**: [validator.ts](validator.ts) (MiniCore),
  [validateAnf.ts](validateAnf.ts) (ANF),
  [validateBlock.ts](validateBlock.ts) (Block).
- **Unparse**: [unparseAnf.ts](unparseAnf.ts), [unparseBlock.ts](unparseBlock.ts).
- **Interpreter**: [evaluator.ts](evaluator.ts) — `evaluateMiniCore` runs a
  MiniCore Program directly without lowering. Used by tests and as a
  reference semantics.
- **Reverse direction**: [anfToMiniCore.ts](anfToMiniCore.ts) raises ANF back
  into MiniCore AST. Used for debugging and for round-trip property tests, not
  in the forward pipeline.

## Runtime ABI

The Block IR may emit calls to runtime functions defined in
[runtime/trip/trip_runtime.h](../../runtime/trip/trip_runtime.h). The set of
permitted runtime symbols and their signatures is defined in
[runtimeSymbols.ts](runtimeSymbols.ts) as `TRIP_RUNTIME_SYMBOLS`.

Current runtime ABI: `trip_read_one : () -> U8`, `trip_write_one : U8 -> Unit`,
plus object allocation/field-access primitives for boxed ADT values.

## Native-v1 subset

The first self-hosting LLVM target accepts only a restricted subset of
MiniCore — no escaping lambdas, no runtime function values, no
function-typed constructor fields, no dynamic callees. Validation lives in
[nativeV1Subset.ts](nativeV1Subset.ts) (`validateNativeV1Subset`,
`NativeV1SubsetError`) and runs before LLVM emission. The object language may
still contain System F terms; the compiler must lower them to first-order MiniCore
before this validator will accept the result.

## Invariants

- Every `SymbolId` and `LocalId` resolves through the program's symbol table.
- `MiniCoreMetadata` is the source of truth for function signatures,
  constructor families, primitive effects, and per-function local types.
  BlockModule's own symbol summaries are advisory only.
- ANF and Block stages preserve MiniCore-level types; lowering to runtime
  representations happens only in the LLVM stage.
- ADT case dispatch stays high-level through Block IR; layout (tags,
  switches, struct shape) is the LLVM stage's concern.
- Native-v1 emission is gated by `validateNativeV1Subset`. If it accepts,
  every value used as a callee is a known direct symbol.
