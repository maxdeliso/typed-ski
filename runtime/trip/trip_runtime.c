#include "trip_runtime.h"

#include <stdio.h>
#include <stdlib.h>

#ifdef _WIN32
#include <fcntl.h>
#include <io.h>

static void configure_binary_stdio(void) {
  _setmode(_fileno(stdin), _O_BINARY);
  _setmode(_fileno(stdout), _O_BINARY);
}
#else
static void configure_binary_stdio(void) {}
#endif

uint8_t trip_read_one(void) {
  configure_binary_stdio();
  int byte = fgetc(stdin);
  if (byte == EOF) {
    return 0;
  }
  return (uint8_t)byte;
}

void trip_write_one(uint8_t byte) {
  configure_binary_stdio();
  (void)fputc((int)byte, stdout);
  (void)fflush(stdout);
}

trip_obj_t *trip_alloc_obj(uint64_t tag, uint64_t arity) {
  if (arity > (UINT64_MAX - sizeof(trip_obj_t)) / sizeof(trip_word_t)) {
    abort();
  }
  size_t bytes = sizeof(trip_obj_t) + (size_t)arity * sizeof(trip_word_t);
  trip_obj_t *obj = (trip_obj_t *)calloc(1, bytes);
  if (obj == NULL) {
    abort();
  }
  obj->tag = tag;
  obj->arity = arity;
  return obj;
}

void trip_obj_set_field(trip_obj_t *obj, uint64_t index, trip_word_t value) {
  if (obj == NULL || index >= obj->arity) {
    abort();
  }
  obj->fields[index] = value;
}

uint64_t trip_obj_tag(const trip_obj_t *obj) {
  if (obj == NULL) {
    abort();
  }
  return obj->tag;
}

trip_word_t trip_obj_field(const trip_obj_t *obj, uint64_t index) {
  if (obj == NULL || index >= obj->arity) {
    abort();
  }
  return obj->fields[index];
}

trip_obj_t *trip_read_stdin_list_u8(void) {
  configure_binary_stdio();

  size_t capacity = 256;
  size_t length = 0;
  uint8_t *bytes = (uint8_t *)malloc(capacity);
  if (bytes == NULL) {
    abort();
  }

  for (;;) {
    int byte = fgetc(stdin);
    if (byte == EOF) {
      break;
    }
    if (length == capacity) {
      size_t next_capacity = capacity * 2;
      if (next_capacity < capacity) {
        free(bytes);
        abort();
      }
      uint8_t *next = (uint8_t *)realloc(bytes, next_capacity);
      if (next == NULL) {
        free(bytes);
        abort();
      }
      bytes = next;
      capacity = next_capacity;
    }
    bytes[length++] = (uint8_t)byte;
  }

  /* Temporary ABI assumption: List U8 tags are hardcoded as 0 (nil) and 1 (cons). 
   * This matches the order in which they are defined in Prelude.trip. */
  trip_obj_t *list = trip_alloc_obj(0, 0);
  while (length > 0) {
    trip_obj_t *cons = trip_alloc_obj(1, 2);
    length--;
    trip_obj_set_field(cons, 0, (trip_word_t)bytes[length]);
    trip_obj_set_field(cons, 1, (trip_word_t)list);
    list = cons;
  }

  free(bytes);
  return list;
}
