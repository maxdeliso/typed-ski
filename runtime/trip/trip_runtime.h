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
trip_obj_t *trip_alloc_obj(uint64_t tag, uint64_t arity);
void trip_obj_set_field(trip_obj_t *obj, uint64_t index, trip_word_t value);
uint64_t trip_obj_tag(const trip_obj_t *obj);
trip_word_t trip_obj_field(const trip_obj_t *obj, uint64_t index);
trip_obj_t *trip_read_stdin_list_u8(void);
#endif
