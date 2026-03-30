#ifdef _WIN32
#ifndef _CRT_SECURE_NO_WARNINGS
#define _CRT_SECURE_NO_WARNINGS
#endif
#endif

#include "util.h"
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static void test_parse_u32_arg(void) {
  printf("test_parse_u32_arg...\n");
  uint32_t value = 0;

  assert(parse_u32_arg("123", &value) == 1 && value == 123);
  assert(parse_u32_arg("0", &value) == 1 && value == 0);
  assert(parse_u32_arg("4294967295", &value) == 1 && value == 0xffffffffu);
  assert(parse_u32_arg("4294967296", &value) == 0);
  assert(parse_u32_arg("abc", &value) == 0);
  assert(parse_u32_arg("", &value) == 0);
  assert(parse_u32_arg(NULL, &value) == 0);
  assert(parse_u32_arg("1", NULL) == 0);
}

static void test_hex_digit(void) {
  printf("test_hex_digit...\n");
  assert(hex_digit('0') == 0);
  assert(hex_digit('9') == 9);
  assert(hex_digit('a') == 10);
  assert(hex_digit('f') == 15);
  assert(hex_digit('A') == 10);
  assert(hex_digit('F') == 15);
  assert(hex_digit('G') == -1);
}

static void test_dynamic_buffer(void) {
  printf("test_dynamic_buffer...\n");
  DynamicBuffer db;
  db_init(&db);
  assert(db.ptr == NULL);
  assert(db.len == 0);
  assert(db.cap == 0);

  assert(db_ensure(&db, 100));
  assert(db.cap >= 100);
  char *first_ptr = db.ptr;
  size_t first_cap = db.cap;

  assert(db_ensure(&db, 50));
  assert(db.ptr == first_ptr);
  assert(db.cap == first_cap);

  assert(db_ensure(&db, 2000));
  assert(db.cap >= 2000);
  assert(!db_ensure(&db, 2000000000ULL));

  db.len = 123;
  db_free(&db);
  assert(db.ptr == NULL);
  assert(db.len == 0);
  assert(db.cap == 0);

  db_init(&db);
  assert(db_append(&db, 'a'));
  assert(db_append(&db, 'b'));
  assert(db_append(&db, '\0'));
  assert(db.len == 3);
  assert(strcmp(db.ptr, "ab") == 0);

  db.len = 0;
  assert(db_append_hex(&db, 0x00));
  assert(db_append_hex(&db, 0xab));
  assert(db_append_hex(&db, 0xff));
  assert(db_append(&db, '\0'));
  assert(db.len == 7);
  assert(strcmp(db.ptr, "00abff") == 0);
  db_free(&db);
}

static void test_db_read_line(void) {
  printf("test_db_read_line...\n");
  FILE *temp = tmpfile();
  assert(temp != NULL);
  assert(fputs("alpha\nbeta", temp) >= 0);
  rewind(temp);

  DynamicBuffer line;
  db_init(&line);
  size_t len = 0;
  assert(db_read_line(temp, &line, &len));
  assert(len == 5);
  assert(strcmp(line.ptr, "alpha") == 0);
  assert(db_read_line(temp, &line, &len));
  assert(len == 4);
  assert(strcmp(line.ptr, "beta") == 0);
  assert(!db_read_line(temp, &line, &len));
  db_free(&line);
  fclose(temp);
}

static void test_print_hex(void) {
  printf("test_print_hex...\n");
  FILE *temp = tmpfile();
  assert(temp != NULL);

  uint8_t buf[] = {0x00, 0xab, 0xff};
  fprint_hex(temp, buf, sizeof(buf));
  fflush(temp);

  rewind(temp);
  char output[16];
  memset(output, 0, sizeof(output));
  size_t n = fread(output, 1, sizeof(output) - 1, temp);
  output[n] = '\0';
  assert(strcmp(output, "00abff") == 0);
  fclose(temp);
}

int main(void) {
  test_parse_u32_arg();
  test_hex_digit();
  test_dynamic_buffer();
  test_db_read_line();
  test_print_hex();
  printf("util_test passed!\n");
  return 0;
}
