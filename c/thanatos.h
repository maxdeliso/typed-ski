#ifndef THANATOS_H
#define THANATOS_H

#include "arena.h"

typedef struct {
  uint32_t num_workers;
  uint32_t arena_capacity;
} ThanatosConfig;

void thanatos_init(ThanatosConfig config);

/** Start worker and dispatcher threads. If enable_stdout_pump is true, also
 * start the thread that forwards arena stdout to process stdout; set false
 * when stdout is used for protocol (e.g. daemon mode). */
void thanatos_start_threads(bool enable_stdout_pump);

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
