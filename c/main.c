#define _DEFAULT_SOURCE
#include "arena.h"
#include "ski_io.h"
#include "thanatos.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#define UNPARSE_BUF_SIZE (256 * 1024)
#define MAX_STEPS 0xffffffffu
#define INITIAL_LINE_CAP 1024

static uint32_t default_num_workers(void) {
  long n = sysconf(_SC_NPROCESSORS_ONLN);
  if (n > 0 && n <= 0xffffffffu)
    return (uint32_t)n;
  return 4;
}

static int run_batch_mode(uint32_t num_workers, uint32_t arena_capacity,
                          char *input, size_t input_len) {
  ThanatosConfig config = {
      .num_workers = num_workers,
      .arena_capacity = arena_capacity,
  };
  thanatos_init(config);

  thanatos_start_threads();

  size_t pos = 0;
  while (pos < input_len) {
    while (pos < input_len && (input[pos] == ' ' || input[pos] == '\t' ||
                               input[pos] == '\r' || input[pos] == '\n'))
      pos++;
    if (pos >= input_len)
      break;

    size_t line_start = pos;
    while (pos < input_len && input[pos] != '\n')
      pos++;
    size_t line_len = pos - line_start;
    if (line_len == 0) {
      if (pos < input_len && input[pos] == '\n')
        pos++;
      continue;
    }
    if (pos < input_len && input[pos] == '\n')
      pos++;

    size_t end_idx = 0;
    uint32_t root = parse_ski(input + line_start, line_len, &end_idx);
    if (root == EMPTY) {
      printf("parse error\n");
      fflush(stdout);
      continue;
    }
    if (end_idx < line_len) {
      fprintf(stderr, "warning: ignoring %zu bytes after expression\n",
              line_len - end_idx);
    }

    uint32_t result = thanatos_reduce(root, MAX_STEPS);
    if (result == EMPTY) {
      printf("reduction error\n");
      fflush(stdout);
      continue;
    }
    char outbuf[UNPARSE_BUF_SIZE];
    size_t n = unparse_ski(result, outbuf, sizeof(outbuf));
    if (n >= sizeof(outbuf)) {
      fprintf(stderr, "result too large to print\n");
      continue;
    }
    printf("%s\n", outbuf);
    fflush(stdout);
  }

  thanatos_shutdown();
  return 0;
}

int main(int argc, char **argv) {
  uint32_t num_workers = default_num_workers();
  uint32_t arena_capacity = 1 << 20;
  int arg_idx = 1;

  if (arg_idx < argc)
    num_workers = (uint32_t)atoi(argv[arg_idx]);
  if (arg_idx + 1 < argc)
    arena_capacity = (uint32_t)atoi(argv[arg_idx + 1]);

  /* Batch mode: read all stdin, then process lines */
  size_t input_cap = INITIAL_LINE_CAP;
  char *input = malloc(input_cap);
  if (!input) {
    fprintf(stderr, "out of memory\n");
    return 1;
  }
  size_t input_len = 0;
  while (1) {
    if (input_len >= input_cap) {
      input_cap *= 2;
      char *p = realloc(input, input_cap);
      if (!p) {
        fprintf(stderr, "out of memory\n");
        free(input);
        return 1;
      }
      input = p;
    }
    size_t want = input_cap - input_len;
    size_t n = fread(input + input_len, 1, want, stdin);
    input_len += n;
    if (n < want)
      break;
  }

  int ret = run_batch_mode(num_workers, arena_capacity, input, input_len);
  free(input);
  return ret;
}
