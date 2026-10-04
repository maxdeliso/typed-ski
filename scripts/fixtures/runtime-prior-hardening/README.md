# Prior-hardening runtime benchmark snapshot

These two files are unmodified `runtime/trip/trip_runtime.c` and
`runtime/trip/trip_runtime.h` from local predecessor commit
`7a447a6d8a738815e6cc9964a4b320d88be5749d`. That intermediate commit is folded
into the final performance trial commit and need not be available in a fresh
clone. Keeping this small snapshot makes the runtime comparison reproducible.

This is benchmark input, not another maintained runtime. Production changes
belong in `runtime/trip/`. `scripts/runtimePerformance.ts` records both input
hashes; `--hardening-ref <revision>` can explicitly select a different Git
revision instead of this snapshot.
