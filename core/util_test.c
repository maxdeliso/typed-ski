#include "util.h"
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/resource.h>
#include <unistd.h>

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
}

static void test_dynamic_buffer_realloc_failure(void) {
  printf("test_dynamic_buffer_realloc_failure...\n");

  struct rlimit old_limit;
  assert(getrlimit(RLIMIT_AS, &old_limit) == 0);

  struct rlimit limited = old_limit;
  limited.rlim_cur = 64ULL * 1024 * 1024;
  if (old_limit.rlim_max != RLIM_INFINITY &&
      limited.rlim_cur > old_limit.rlim_max) {
    limited.rlim_cur = old_limit.rlim_max;
  }
  if (limited.rlim_cur < 64ULL * 1024 * 1024) {
    return;
  }
  assert(setrlimit(RLIMIT_AS, &limited) == 0);

  DynamicBuffer db;
  db_init(&db);
  assert(!db_ensure(&db, 512ULL * 1024 * 1024));
  db_free(&db);

  assert(setrlimit(RLIMIT_AS, &old_limit) == 0);
}

static void test_print_hex(void) {
  printf("test_print_hex...\n");
  fflush(stdout);
  int saved_stdout = dup(fileno(stdout));
  assert(saved_stdout >= 0);

  FILE *temp = tmpfile();
  assert(temp != NULL);
  assert(dup2(fileno(temp), fileno(stdout)) >= 0);

  uint8_t buf[] = {0x00, 0xab, 0xff};
  print_hex(buf, sizeof(buf));
  fflush(stdout);

  assert(dup2(saved_stdout, fileno(stdout)) >= 0);
  close(saved_stdout);

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
  test_dynamic_buffer_realloc_failure();
  test_print_hex();
  printf("util_test passed!\n");
  return 0;
}
