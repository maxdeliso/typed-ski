#ifndef UTIL_H
#define UTIL_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

typedef struct {
  char *ptr;
  size_t len;
  size_t cap;
} DynamicBuffer;

void db_init(DynamicBuffer *db);
void db_free(DynamicBuffer *db);
bool db_ensure(DynamicBuffer *db, size_t want);
bool db_append(DynamicBuffer *db, char c);
bool db_append_hex(DynamicBuffer *db, uint8_t byte);

int parse_u32_arg(const char *text, uint32_t *out);
int hex_digit(int c);
void print_hex(const uint8_t *buf, size_t len);

#endif
