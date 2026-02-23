#ifndef THANATOS_H
#define THANATOS_H

#include "arena.h"

typedef struct {
  uint32_t num_workers;
  uint32_t arena_capacity;
} ThanatosConfig;

void thanatos_init(ThanatosConfig config);

/** Start worker/dispatcher/stdout threads. Call after parsing stdin. */
void thanatos_start_threads(void);

uint32_t thanatos_reduce(uint32_t node_id, uint32_t max_steps);

void thanatos_shutdown(void);

#endif
