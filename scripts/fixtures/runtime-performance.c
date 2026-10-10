/* Fixed workload: compile these exact bytes against every runtime revision. */
#include "trip_runtime.h"

#include <inttypes.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static uint8_t byte_at(uint64_t index) {
  return (uint8_t)(index * 37 + 11);
}

int main(int argc, char **argv) {
  if (argc != 3) return 2;
  uint64_t count = strtoull(argv[2], NULL, 10);
  uint64_t checksum = 0;
  if (strcmp(argv[1], "allocate") == 0) {
    static const uint64_t arities[] = {0, 1, 2, 3, 4, 8};
    for (uint64_t i = 0; i < count; i++) {
      uint64_t arity = arities[i % 6];
      trip_obj_t *obj = trip_alloc_obj(i % 17, arity);
      for (uint64_t field = 0; field < arity; field++) {
        if (obj->fields[field] != 0) return 3;
        trip_obj_set_field(obj, field, (trip_word_t)(i + field));
      }
      checksum += obj->tag + arity;
    }
  } else if (strcmp(argv[1], "access") == 0) {
    trip_obj_t *objects[1024];
    for (uint64_t i = 0; i < 1024; i++) {
      objects[i] = trip_alloc_obj(i % 17, 4);
      for (uint64_t field = 0; field < 4; field++) {
        trip_obj_set_field(objects[i], field, (trip_word_t)(i + field));
      }
    }
    for (uint64_t i = 0; i < count; i++) {
      trip_obj_t *obj = objects[i % 1024];
      checksum += trip_obj_tag(obj) + trip_obj_field(obj, i % 4);
    }
  } else if (strcmp(argv[1], "input-list") == 0) {
    trip_obj_t *list = trip_read_stdin_list_u8();
    uint64_t length = 0;
    while (list->tag == 1) {
      if (list->arity != 2 || list->fields[0] != byte_at(length)) return 4;
      checksum += list->fields[0];
      list = (trip_obj_t *)list->fields[1];
      length++;
    }
    if (list->tag != 0 || list->arity != 0 || length != count) return 5;
  } else if (strcmp(argv[1], "input-byte") == 0) {
    for (uint64_t i = 0; i < count; i++) {
      uint8_t byte = trip_read_one();
      if (byte != byte_at(i)) return 6;
      checksum += byte;
    }
    if (trip_read_one() != 0) return 7;
  } else if (strcmp(argv[1], "output-byte") == 0) {
    for (uint64_t i = 0; i < count; i++) trip_write_one(byte_at(i));
    return 0;
  } else {
    return 2;
  }
  printf("%" PRIu64, checksum);
  return 0;
}
