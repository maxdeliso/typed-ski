#include "session.h"
#include "arena.h"
#include "ski_io.h"
#include "thanatos.h"
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static void assert_contains(const char *haystack, const char *needle) {
  assert(strstr(haystack, needle) != NULL);
}

static void surface_to_dag(const char *surface, char *out, size_t out_cap) {
  size_t end = 0;
  uint32_t root = parse_ski(surface, strlen(surface), &end);
  assert(root != EMPTY);
  assert(end == strlen(surface));
  size_t n = unparse_dag(root, out, out_cap);
  assert(n > 0);
  assert(n < out_cap);
  reset();
}

static void write_one_byte_file(const char *path, int byte) {
  FILE *fp = fopen(path, "wb");
  assert(fp != NULL);
  assert(fputc(byte, fp) == byte);
  fclose(fp);
}

static void write_bytes_file(const char *path, const uint8_t *bytes, size_t len) {
  FILE *fp = fopen(path, "wb");
  assert(fp != NULL);
  if (len > 0) {
    assert(fwrite(bytes, 1, len, fp) == len);
  }
  fclose(fp);
}

static int read_one_byte_file(const char *path) {
  FILE *fp = fopen(path, "rb");
  assert(fp != NULL);
  int byte = fgetc(fp);
  assert(fgetc(fp) == EOF);
  fclose(fp);
  return byte;
}

static void test_daemon_success_paths(void) {
  printf("test_daemon_success_paths...\n");
  reset();
  thanatos_reset_stats();

  char reduce_dag[128];
  char step_dag[128];
  char write_dag[256];
  char write_result_dag[128];
  char file_dag[256];
  char file_result_dag[128];
  surface_to_dag("I", reduce_dag, sizeof(reduce_dag));
  surface_to_dag("I", step_dag, sizeof(step_dag));
  surface_to_dag(". #u8(42) I", write_dag, sizeof(write_dag));
  surface_to_dag("#u8(42)", write_result_dag, sizeof(write_result_dag));
  surface_to_dag(", (C . I) I", file_dag, sizeof(file_dag));
  surface_to_dag("#u8(42) I", file_result_dag, sizeof(file_result_dag));

  char output[8192];
  memset(output, 0, sizeof(output));
  FILE *mem = fmemopen(output, sizeof(output), "w");
  assert(mem != NULL);

  ThanatosSession s;
  thanatos_session_init(&s, true, true, mem);

  thanatos_session_handle_line(&s, "PING", 4);
  thanatos_session_handle_line(&s, "STATS", 5);
  thanatos_session_handle_line(&s, "RESET", 5);

  char command[2048];
  int n = snprintf(command, sizeof(command), "REDUCE %s", reduce_dag);
  assert(n > 0 && (size_t)n < sizeof(command));
  thanatos_session_handle_line(&s, command, (size_t)n);

  n = snprintf(command, sizeof(command), "REDUCE_IO - %s", write_dag);
  assert(n > 0 && (size_t)n < sizeof(command));
  thanatos_session_handle_line(&s, command, (size_t)n);

  n = snprintf(command, sizeof(command), "REDUCE_IO 2a %s", file_dag);
  assert(n > 0 && (size_t)n < sizeof(command));
  thanatos_session_handle_line(&s, command, (size_t)n);

  n = snprintf(command, sizeof(command), "STEP 1 %s", step_dag);
  assert(n > 0 && (size_t)n < sizeof(command));
  thanatos_session_handle_line(&s, command, (size_t)n);

  const char *input_path = "session test in.bin";
  const char *output_path = "session test out.bin";
  const char *plain_input_path = "session-in.bin";
  const char *plain_output_path = "session-out.bin";
  write_one_byte_file(input_path, 42);
  write_one_byte_file(plain_input_path, 42);

  n = snprintf(command, sizeof(command), "REDUCE_FILE \"%s\" \"%s\" %s",
               input_path, output_path, file_dag);
  assert(n > 0 && (size_t)n < sizeof(command));
  thanatos_session_handle_line(&s, command, (size_t)n);

  n = snprintf(command, sizeof(command), "REDUCE_FILE %s %s %s",
               plain_input_path, plain_output_path, file_dag);
  assert(n > 0 && (size_t)n < sizeof(command));
  thanatos_session_handle_line(&s, command, (size_t)n);

  fflush(mem);

  char expected[256];
  assert_contains(output, "OK\n");
  assert_contains(output, "OK top=");
  snprintf(expected, sizeof(expected), "OK %s\n", reduce_dag);
  assert_contains(output, expected);
  snprintf(expected, sizeof(expected), "OK 2a %s\n", write_result_dag);
  assert_contains(output, expected);
  snprintf(expected, sizeof(expected), "OK 2a %s\n", file_result_dag);
  assert_contains(output, expected);
  snprintf(expected, sizeof(expected), "OK %s\n", step_dag);
  assert_contains(output, expected);
  snprintf(expected, sizeof(expected), "OK %s\n", file_result_dag);
  assert_contains(output, expected);

  assert(read_one_byte_file(output_path) == 42);
  assert(read_one_byte_file(plain_output_path) == 42);
  remove(input_path);
  remove(output_path);
  remove(plain_input_path);
  remove(plain_output_path);

  fclose(mem);
  thanatos_session_free(&s);
}

static void test_daemon_errors(void) {
  printf("test_daemon_errors...\n");
  reset();
  thanatos_reset_stats();

  char identity_dag[128];
  char file_dag[256];
  surface_to_dag("I", identity_dag, sizeof(identity_dag));
  surface_to_dag(", (C . I) I", file_dag, sizeof(file_dag));

  char output[16384];
  memset(output, 0, sizeof(output));
  FILE *mem = fmemopen(output, sizeof(output), "w");
  assert(mem != NULL);

  ThanatosSession s;
  thanatos_session_init(&s, true, true, mem);

  thanatos_session_handle_line(&s, "GIBBERISH", 9);
  thanatos_session_handle_line(&s, "REDUCE", 6);
  thanatos_session_handle_line(&s, "REDUCE @1,1", 11);
  thanatos_session_handle_line(&s, "REDUCE_IO", 9);
  thanatos_session_handle_line(&s, "REDUCE_IO XY I", 14);
  thanatos_session_handle_line(&s, "REDUCE_IO ABC I", 15);
  thanatos_session_handle_line(&s, "REDUCE_IO 2a @1,1", 16);
  thanatos_session_handle_line(&s, "REDUCE_FILE only_input",
                               strlen("REDUCE_FILE only_input"));
  thanatos_session_handle_line(&s, "STEP", 4);
  thanatos_session_handle_line(&s, "STEP 1", 6);
  thanatos_session_handle_line(&s, "STEP 1 @1,1", 10);

  char command[4096];
  int n = snprintf(command, sizeof(command), "REDUCE_FILE missing.bin out.bin %s",
                   identity_dag);
  assert(n > 0 && (size_t)n < sizeof(command));
  thanatos_session_handle_line(&s, command, (size_t)n);

  const char *input_path = "session error in.bin";
  const char *empty_input_path = "session empty in.bin";
  const char *empty_output_path = "session empty out.bin";
  write_one_byte_file(input_path, 42);
  write_bytes_file(empty_input_path, NULL, 0);
  n = snprintf(command, sizeof(command),
               "REDUCE_FILE \"%s\" no/such/dir/out.bin %s", input_path,
               identity_dag);
  assert(n > 0 && (size_t)n < sizeof(command));
  thanatos_session_handle_line(&s, command, (size_t)n);

  n = snprintf(command, sizeof(command), "REDUCE_FILE \"%s\" \"%s\" @1,1",
               input_path, empty_output_path);
  assert(n > 0 && (size_t)n < sizeof(command));
  thanatos_session_handle_line(&s, command, (size_t)n);

  n = snprintf(command, sizeof(command), "REDUCE_FILE \"%s\" \"%s\" %s",
               empty_input_path, empty_output_path, file_dag);
  assert(n > 0 && (size_t)n < sizeof(command));
  thanatos_session_handle_line(&s, command, (size_t)n);

  if (access("/dev/full", F_OK) == 0) {
    n = snprintf(command, sizeof(command), "REDUCE_FILE /dev/null /dev/full %s",
                 identity_dag);
    assert(n > 0 && (size_t)n < sizeof(command));
    thanatos_session_handle_line(&s, command, (size_t)n);
  }

  char long_path[1025];
  memset(long_path, 'a', sizeof(long_path) - 1);
  long_path[sizeof(long_path) - 1] = '\0';

  n = snprintf(command, sizeof(command), "REDUCE_FILE \"%s\" out.bin %s",
               long_path, identity_dag);
  assert(n > 0 && (size_t)n < sizeof(command));
  thanatos_session_handle_line(&s, command, (size_t)n);

  n = snprintf(command, sizeof(command), "REDUCE_FILE in.bin \"%s\" %s",
               long_path, identity_dag);
  assert(n > 0 && (size_t)n < sizeof(command));
  thanatos_session_handle_line(&s, command, (size_t)n);

  fflush(mem);

  assert_contains(output, "ERR unknown command\n");
  assert_contains(output, "ERR REDUCE requires payload\n");
  assert_contains(output, "ERR parse error\n");
  assert_contains(output, "ERR REDUCE_IO requires <stdin_hex> <dag>\n");
  assert_contains(output, "ERR REDUCE_IO invalid hex digit\n");
  assert_contains(output, "ERR REDUCE_IO hex must be even length\n");
  assert_contains(output, "ERR reduction error\n");
  assert_contains(output, "ERR REDUCE_FILE requires <in_path> <out_path> <dag>\n");
  assert_contains(output, "ERR cannot open input file\n");
  assert_contains(output, "ERR cannot open output file\n");
  assert_contains(output, "ERR path too long (max 1023 chars)\n");
  assert_contains(output, "ERR STEP requires step_count and DAG payload\n");
  assert_contains(output, "ERR STEP requires DAG payload\n");
  if (access("/dev/full", F_OK) == 0) {
    assert_contains(output, "ERR ftruncate output failed\n");
  }

  remove(input_path);
  remove(empty_input_path);
  remove(empty_output_path);
  fclose(mem);
  thanatos_session_free(&s);
}

static void test_non_daemon_surface_mode(void) {
  printf("test_non_daemon_surface_mode...\n");
  reset();
  thanatos_reset_stats();

  char output[4096];
  memset(output, 0, sizeof(output));
  FILE *mem = fmemopen(output, sizeof(output), "w");
  assert(mem != NULL);

  ThanatosSession s;
  thanatos_session_init(&s, false, false, mem);

  thanatos_session_handle_line(&s, "I K", 3);
  thanatos_session_handle_line(&s, "STATS", 5);
  thanatos_session_handle_line(&s, "(", 1);

  fflush(mem);
  assert_contains(output, "K\n");
  assert_contains(output, "top=");
  assert_contains(output, "parse error\n");
  assert(strstr(output, "OK top=") == NULL);

  fclose(mem);
  thanatos_session_free(&s);
}

int main(void) {
  ThanatosConfig config = {
      .num_workers = 0,
      .arena_capacity = 0,
      .stdin_fd = -1,
  };
  setenv("THANATOS_TRACE", "1", 1);
  thanatos_init(config);
  thanatos_start_threads(true);
  thanatos_start_threads(true);

  test_daemon_success_paths();
  test_daemon_errors();
  test_non_daemon_surface_mode();

  thanatos_shutdown();
  printf("session_test passed!\n");
  return 0;
}
