#ifndef THANATOS_H
#define THANATOS_H

#include "arena.h"
typedef struct {
  uint32_t num_workers;
  uint32_t arena_capacity;
  /** Optional runtime stdin stream for READ_ONE (separate from program/SKI
   * input). Pass -1 when no runtime stdin source is available. Thanatos reads
   * one byte lazily for each blocked READ_ONE suspension and takes ownership of
   * the fd (it is closed by thanatos_shutdown). */
  int stdin_fd;
} ThanatosConfig;

/* READ_ONE semantics now match JS/WASM more closely: if no byte is available
 * yet, native waits until one arrives instead of failing. If stdin_fd == -1,
 * READ_ONE remains parked indefinitely. For regular files, EOF is treated as a
 * temporary condition so appending later bytes will wake pending reads. */

void thanatos_init(ThanatosConfig config);

/** Set a callback for arena stdout bytes. If set, thanatos_reduce and the
 * pump will call this instead of putchar(). */
void thanatos_set_stdout_handler(void (*handler)(uint8_t, void *), void *ctx);

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
                        unsigned long long *out_total_nodes,
                        unsigned long long *out_total_steps,
                        unsigned long long *out_total_cons_allocs,
                        unsigned long long *out_total_cont_allocs,
                        unsigned long long *out_total_susp_allocs,
                        unsigned long long *out_duplicate_lost_allocs,
                        unsigned long long *out_hashcons_hits,
                        unsigned long long *out_hashcons_misses,
                        unsigned long long *out_events,
                        unsigned long long *out_dropped);

/** Reset daemon-level counters that are reported by STATS but not owned by the
 * arena (e.g. dispatcher events/dropped). */
void thanatos_reset_stats(void);

void thanatos_shutdown(void);

#endif
