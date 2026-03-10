#ifndef THANATOS_H
#define THANATOS_H

#include "arena.h"
#include <stddef.h>

typedef struct {
  uint32_t num_workers;
  uint32_t arena_capacity;
  /** Optional runtime stdin for READ_ONE (separate from program/SKI input).
   * Model: preloaded finite byte source, not asynchronous streaming. */
  const uint8_t *stdin_bytes;
  size_t stdin_len;
  /** Current read position; thanatos advances on each READ_ONE. NULL if not
   * used. */
  size_t *stdin_pos;
} ThanatosConfig;

/* EOF semantics for READ_ONE: when stdin_bytes is exhausted we treat it as
 * a hard error (reduction fails, return EMPTY). This is intentionally stricter
 * than JS/WASM, which blocks (waits for the host to call writeStdin) rather
 * than failing. Native does not implement blocking wait for more input. */

void thanatos_init(ThanatosConfig config);

/** Start worker and dispatcher threads. If enable_stdout_pump is true, also
 * start the thread that forwards arena stdout to process stdout; set false
 * when stdout is used for protocol (e.g. daemon mode).
 *
 * Any mode that supports WRITE_ONE (program stdout) must start the pump
 * (enable_stdout_pump true) or provide a synchronous drain path; otherwise
 * WRITE_ONE waiters may never resume. */
void thanatos_start_threads(bool enable_stdout_pump);

/** Reduce with optional stdin (from config). Use same binary as JS/WASM for
 * identical stdout. */
uint32_t thanatos_reduce(uint32_t node_id, uint32_t max_steps);

/** Reduce to normal form (unbounded steps). Convenience for daemon REDUCE. */
uint32_t thanatos_reduce_to_normal_form(uint32_t node_id);

/** Fill in stats for daemon STATS: arena top/capacity and dispatcher
 * events/dropped. */
void thanatos_get_stats(uint32_t *out_top, uint32_t *out_capacity,
                        unsigned long long *out_events,
                        unsigned long long *out_dropped);

void thanatos_shutdown(void);

#endif
