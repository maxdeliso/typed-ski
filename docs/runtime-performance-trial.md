# GPT-6.1 Sol Ultra performance trial

This trial compares the implementation produced in this pass with predecessor
code. It measures compiler/runtime changes on one Windows x64 machine; it does
not establish a general ranking of models or reasoning settings.

## Reproducible comparisons

The runtime comparison uses these inputs:

- Main: `ea97a8286fe88a16f84cd4ec673a103cad0a1791`.
- Prior hardening: `7a447a6d8a738815e6cc9964a4b320d88be5749d`, preserved as the
  unmodified C/header snapshot in `scripts/fixtures/runtime-prior-hardening/`.
  This intermediate local commit is folded into the final trial commit, so a
  fresh clone can use the snapshot without fetching unpublished history.
- Candidate: the production `runtime/trip/` files, with their exact hashes in
  the recorded results.

The same C workload bytes are compiled against all three runtimes. The real
compiler comparison likewise links one fixed Stage-1 LLVM artifact against
each runtime and supplies the same complete compiler bundle. The source bundle
comes from the frozen, reachable main revision. The current host compiler
generates its Stage-1 LLVM once; those exact LLVM bytes are then held fixed
across runtime comparisons. Bundle, LLVM, and executed host identities are
recorded separately.
All versions use the same Clang executable and `-O3 -std=c11` flags, without
LTO or profile-guided optimization.

The separate compiler-design comparison builds predecessor and candidate
Stage-1 compilers from their respective source bundles using the same host.
Each Stage-1 executable compiles its own source bundle into Stage 2. The
harness links both Stage-2 artifacts against the exact candidate runtime and
executes those binaries on the same frozen main compiler bundle. This measures the generated compiler's
allocation behavior, including immutable global function objects. These LLVM
artifacts necessarily differ. The harness compiles their outputs, asks both
resulting compilers to build an observable correctness anchor, and checks its
exact output outside the timed region.

Each workload has one untimed warmup per implementation. C workloads have
five measured repetitions and full compiler workloads have three. Execution
is serial, with the starting implementation rotated between repetitions.
The native process monitor measures creation through termination, including
runtime cleanup, and records child peak working set using Windows
`GetProcessMemoryInfo`. Parent Node memory is excluded. Raw samples, ranges,
allocation counters where available, output hashes, toolchain, hardware, and
input hashes are retained in the JSON reports. The final Stage-2 report also
records the paths and hashes of the native binaries passed to the monitor.

Output modes are reported separately. Default `trip_write_one` still makes
each byte immediately visible. Buffered trials set
`TRIP_RUNTIME_BUFFER_OUTPUT=1` on every implementation; historical runtimes
ignore that option. The candidate buffers explicitly opted-in output, flushes
before reads and at normal exit, and exposes an explicit flush operation.
The default build omits `TRIP_RUNTIME_VALIDATE_POINTERS`; enable it for the
additional Windows pointer probes when investigating memory corruption.

The compiler design shares immutable closed global function objects and builds
LLVM function blocks directly onto the main-wrapper suffix. Only the small
target/runtime header is copied when prepending it. This preserves output bytes
while sharing the completed LLVM list tail; appending a footer after emission
or concatenating the full output would allocate another pair of byte-list
copies. Captured closures and partial applications still allocate.

## C workload results

Measured October 3, 2026 on an Intel Core i7-7820X, Windows x64, Node 26.8.1,
and Clang 20.1.7. These are median elapsed milliseconds for complete processes,
including startup and exit:

| Workload                                  |     Main | Prior hardening | Candidate |
| ----------------------------------------- | -------: | --------------: | --------: |
| Allocate 1,000,000 mixed objects          |   146.67 |           77.40 |     76.54 |
| 4,000,000 tag/field accessor pairs        |    86.93 |           92.00 |     80.18 |
| Read 1 MiB into the runtime byte list     |   201.35 |          109.47 |     77.75 |
| Read 1 MiB through single-byte calls      |   137.10 |           80.25 |     82.30 |
| Write 1 MiB, default immediate output     | 3,600.72 |        3,670.15 |  3,548.68 |
| Write 1 MiB, buffering explicitly enabled | 3,663.97 |        3,867.63 |     66.42 |

The previous arena already delivered most of the allocation-throughput gain
over main. This pass improves bulk list input and opted-in output while
preserving immediate output behavior. Single-byte input does not show an
improvement over prior hardening in this run.

For 1,024 mixed objects, the candidate reserves 65,560 arena bytes versus
1,048,600 in prior hardening; both processes peak around 5.1 MiB because startup
and touched pages dominate. At 1,000,000 objects, both arenas peak around
43.0 MiB versus main's 56.4 MiB. The Windows ABI already aligns objects to eight
bytes, so the new natural-alignment policy does not produce a large object-size
reduction here.

## Fixed-LLVM full compiler results

The following series ran after all other coordinated compiler/test work had
finished. Earlier overlapping full-compiler samples were discarded; the C
workloads above finished before that overlap and were retained.

| Runtime         | Default immediate output, seconds | Buffering enabled, seconds | Peak working set, MiB |
| --------------- | --------------------------------: | -------------------------: | --------------------: |
| Main            |                            22.386 |                     21.954 |              2,530.65 |
| Prior hardening |                            16.438 |                     16.840 |              1,699.85 |
| Candidate       |                            14.528 |                      2.554 |     1,699.45–1,699.52 |

The candidate is 1.54× faster than main with the default output contract, and
8.60× faster in the explicitly buffered case. Its peak memory is about 32.8%
lower than main and essentially unchanged from prior hardening. Both arenas
allocate 59,641,292 logical objects totaling 1,769,011,848 object bytes: these
are runtime/allocator/I/O gains rather than fewer compiler objects. Every run
emits the same 3,401,330-byte LLVM output, including across both output modes.

Raw timings, counters, and input/output hashes are in
[the runtime report](runtime-performance-trial.runtime.windows-x64.json).

## Generated Stage-2 compiler results

This separate series measures the self-hosted predecessor and candidate
compilers against the same candidate runtime and frozen main input bundle.
It ran after final correctness acceptance, with no other coordinated compiler
or test execution.

| Stage-2 compiler | Default immediate output, seconds | Buffering enabled, seconds | Peak working set, MiB |
| ---------------- | --------------------------------: | -------------------------: | --------------------: |
| Predecessor main |                            16.006 |                      3.843 |     3,019.20–3,019.26 |
| Candidate        |                            15.926 |                      3.659 |     2,712.57–2,712.64 |

Default-output timing is effectively unchanged: predecessor samples span
15.945–16.168 seconds and candidate samples 15.876–16.018 seconds. In this buffered
series, the candidate median is about 4.8% lower; sample ranges are
3.826–3.894 seconds and 3.626–3.730 seconds respectively. Three samples on one
machine do not establish a broad performance claim.

The allocation improvement is deterministic across every measured run and
output mode. The predecessor allocates 125,644,176 objects totaling
3,147,408,592 bytes; the candidate allocates 115,718,462 objects totaling
2,827,138,472 bytes. That is 7.9% fewer objects, 10.2% fewer object bytes, and
about 10.2% lower peak working set. These totals include captured closures,
text/list construction, parsing, and compiler transformations; they do not
attribute all savings to static function objects.

An earlier candidate had a real allocation regression: 136,120,371 objects
and 3,479,999,424 bytes. Global-name indexing/deduplication changes alone left
the full-compiler cost essentially unchanged at 136,120,383 objects and
3,479,999,848 bytes. Inspection then found completed LLVM byte lists being
copied when concatenating the header and appending the wrapper. Building onto
the wrapper suffix and sharing the emitted tail removed 20,401,921 objects
and 652,861,376 bytes from that intermediate candidate, while preserving its
exact emitted output. The
[initial](runtime-performance-trial.stage2-initial.windows-x64.json) and
[intermediate](runtime-performance-trial.stage2-intermediate.windows-x64.json)
reports retain those regressions and source identities.

Predecessor and candidate emit different LLVM because the implementation
changed, but each output is stable across repetitions and output modes.
Both emitted compilers compile and execute the correctness anchor with the
exact output `A`. The final candidate source bundle is identified by SHA-256
`8ba0b1e79445821a0aca6140f6fce64a98cc98e80a51da9abbf4686ac8d223af`.
LLVM artifacts, measured executable identities, raw samples, and anchor hashes
are in [the final Stage-2 report](runtime-performance-trial.compiler.windows-x64.json).

## Reproduce

From a normal checkout with dependencies installed:

```text
node scripts/generate_version.mjs --package-json package.json --ts-out lib/shared/version.generated.ts
pnpm run build:ts
node ts_out/scripts/runtimePerformance.js --output .tmp/runtime-performance.json
```

Clang discovery uses the project's Bazel toolchain, or an explicit
`TYPED_SKI_CLANG` path. The trial recorded here used system Clang 20.1.7 with
the MSVC target; use the same toolchain to compare its absolute times.
The harness supports `--skip-bootstrap` for C-only trials, `--runtime-only`
for the controlled runtime comparison, and `--emission-only` for the Stage-2
comparison. `--compiler-source-ref` deliberately changes the frozen compiler
source; `--hardening-ref` selects an available Git revision instead of the
checked-in runtime snapshot. Temporary native/LLVM artifacts stay under
`.tmp/runtime-performance/`.

The compiler artifact cache fingerprints the host code actually executed
(`ts_out/lib/*.js` for the built command), the frozen input bundle, Node version,
and lockfile. A rebuild that changes executed host bytes invalidates the cache.
Source TypeScript and executed harness/host identities are captured separately
at startup.

## Remaining limits

Objects still live for the process lifetime. Arenas reduce allocator overhead
and reserve memory more deliberately; they do not collect unreachable objects
or bound a long-running process's total memory. The compiler still uses linked
byte lists, repeated string/list construction, and dynamically allocated
captured closures. The measured full compiler workload is one bootstrap bundle,
not a broad workload distribution.

The next useful design work is allocation attribution by compiler phase,
followed by a text representation that avoids repeated linked-list copying.
Overall counters show the cost, but do not identify which transformation owns
it. A collection or scoped-lifetime design should follow an explicit account
of live references across phases and closure calls.

Small processes on this Windows host have roughly 50–70 ms of startup overhead.
The tiny allocation case demonstrates arena reservation behavior, not a useful
throughput claim. Natural object alignment also does not promise an allocation
size reduction on every ABI. Prefer the full compiler and allocation counters
when assessing practical impact; retain raw timing ranges when investigating
noise or a regression.
