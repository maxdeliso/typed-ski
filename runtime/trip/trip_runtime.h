#ifndef TRIP_RUNTIME_H
#define TRIP_RUNTIME_H

#include <stdint.h>

typedef uintptr_t trip_word_t;

typedef struct trip_obj {
  uint64_t tag;
  uint64_t arity;
  trip_word_t fields[];
} trip_obj_t;

uint8_t trip_read_one(void);
void trip_write_one(uint8_t byte);
/* Writes are immediately visible by default. TRIP_RUNTIME_BUFFER_OUTPUT=1 opts
 * into bounded buffering; reads and normal exit flush automatically. A caller
 * can flush explicitly before an external interaction that does not read stdin. */
void trip_flush_stdout(void);
/* Objects are zero-initialized and aligned for trip_obj_t, not max_align_t. */
trip_obj_t *trip_alloc_obj(uint64_t tag, uint64_t arity);
void trip_obj_set_field(trip_obj_t *obj, uint64_t index, trip_word_t value);
uint64_t trip_obj_tag(const trip_obj_t *obj);
trip_word_t trip_obj_field(const trip_obj_t *obj, uint64_t index);
trip_obj_t *trip_read_stdin_list_u8(void);

/* The runtime is single-threaded. Objects live until process exit. These
 * cumulative counters expose that cost; unreachable objects are not collected. */
typedef struct trip_allocation_stats {
  uint64_t objects;
  uint64_t object_bytes;
  uint64_t reserved_bytes;
  uint64_t chunks;
} trip_allocation_stats_t;

trip_allocation_stats_t trip_allocation_stats(void);
#endif
