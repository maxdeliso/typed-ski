#include "util.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

void db_init(DynamicBuffer *db) {
  db->ptr = NULL;
  db->len = 0;
  db->cap = 0;
}

void db_free(DynamicBuffer *db) {
  free(db->ptr);
  db->ptr = NULL;
  db->len = 0;
  db->cap = 0;
}

bool db_ensure(DynamicBuffer *db, size_t want) {
  if (want <= db->cap)
    return true;
  size_t new_cap = db->cap == 0 ? 1024 : db->cap * 2;
  while (new_cap < want)
    new_cap *= 2;

  if (new_cap > 1024 * 1024 * 1024) { /* 1GB limit */
    fprintf(stderr, "util: dynamic buffer exceeds safety limit\n");
    return false;
  }

  char *new_ptr = realloc(db->ptr, new_cap);
  if (!new_ptr) {
    fprintf(stderr, "util: out of memory for dynamic buffer (%zu bytes)\n",
            new_cap);
    return false;
  }
  db->ptr = new_ptr;
  db->cap = new_cap;
  return true;
}

int parse_u32_arg(const char *text, uint32_t *out) {
  uint64_t value = 0;
  if (text == NULL || out == NULL || *text == '\0')
    return 0;
  for (const unsigned char *p = (const unsigned char *)text; *p != '\0'; p++) {
    if (*p < '0' || *p > '9')
      return 0;
    value = value * 10u + (uint64_t)(*p - '0');
    if (value > 0xffffffffu)
      return 0;
  }
  *out = (uint32_t)value;
  return 1;
}

int hex_digit(int c) {
  if (c >= '0' && c <= '9')
    return c - '0';
  if (c >= 'a' && c <= 'f')
    return c - 'a' + 10;
  if (c >= 'A' && c <= 'F')
    return c - 'A' + 10;
  return -1;
}

void print_hex(const uint8_t *buf, size_t len) {
  for (size_t i = 0; i < len; i++) {
    printf("%02x", buf[i]);
  }
}
