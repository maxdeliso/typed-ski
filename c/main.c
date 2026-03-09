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

/*
 * Modes:
 *   --daemon: clean protocol channel; stdout is line protocol only (pump
 * disabled). batch (default): legacy behavior; stdout may include program
 * output (pump enabled).
 */

static uint32_t default_num_workers(void) {
  long n = sysconf(_SC_NPROCESSORS_ONLN);
  if (n > 0 && n <= 0xffffffffu)
    return (uint32_t)n;
  return 4;
}

static int run_batch_mode(uint32_t num_workers, uint32_t arena_capacity,
                          char *input, size_t input_len, int use_dag) {
  ThanatosConfig config = {
      .num_workers = num_workers,
      .arena_capacity = arena_capacity,
  };
  thanatos_init(config);

  thanatos_start_threads(true);

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
    uint32_t root;
    if (use_dag) {
      root = parse_dag(input + line_start, line_len, &end_idx);
    } else {
      root = parse_ski(input + line_start, line_len, &end_idx);
    }
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
    size_t n;
    if (use_dag) {
      n = unparse_dag(result, outbuf, sizeof(outbuf));
      if (n == (size_t)-1) {
        fprintf(stderr, "result too large to print\n");
        continue;
      }
      if (n == 0) {
        fprintf(stderr, "result not exportable (suspension/continuation)\n");
        continue;
      }
    } else {
      n = unparse_ski(result, outbuf, sizeof(outbuf));
      if (n >= sizeof(outbuf)) {
        fprintf(stderr, "result too large to print\n");
        continue;
      }
    }
    printf("%s\n", outbuf);
    fflush(stdout);
  }

  thanatos_shutdown();
  return 0;
}

static int run_daemon_mode(uint32_t num_workers, uint32_t arena_capacity) {
  ThanatosConfig config = {
      .num_workers = num_workers,
      .arena_capacity = arena_capacity,
  };
  thanatos_init(config);
  thanatos_start_threads(false);

  char *line = NULL;
  size_t line_cap = 0;
  static char outbuf[UNPARSE_BUF_SIZE];

  while (1) {
    ssize_t nread = getline(&line, &line_cap, stdin);
    if (nread <= 0)
      break;
    if (nread > 0 && line[nread - 1] == '\n')
      line[--nread] = '\0';
    size_t len = (size_t)nread;
    while (len > 0 && (line[len - 1] == '\r' || line[len - 1] == ' ' ||
                       line[len - 1] == '\t'))
      len--;
    if (len == 0) {
      printf("ERR empty line\n");
      fflush(stdout);
      continue;
    }

    if (len >= 4 && line[0] == 'Q' && line[1] == 'U' && line[2] == 'I' &&
        line[3] == 'T' && (len == 4 || line[4] == ' ' || line[4] == '\t')) {
      printf("OK\n");
      fflush(stdout);
      break;
    }
    if (len >= 4 && line[0] == 'P' && line[1] == 'I' && line[2] == 'N' &&
        line[3] == 'G' && (len == 4 || line[4] == ' ' || line[4] == '\t')) {
      printf("OK\n");
      fflush(stdout);
      continue;
    }
    if (len >= 5 && line[0] == 'R' && line[1] == 'E' && line[2] == 'S' &&
        line[3] == 'E' && line[4] == 'T' &&
        (len == 5 || line[5] == ' ' || line[5] == '\t')) {
      reset();
      printf("OK\n");
      fflush(stdout);
      continue;
    }
    if (len >= 5 && line[0] == 'S' && line[1] == 'T' && line[2] == 'A' &&
        line[3] == 'T' && line[4] == 'S' &&
        (len == 5 || line[5] == ' ' || line[5] == '\t')) {
      uint32_t top = 0, capacity = 0;
      unsigned long long events = 0, dropped = 0;
      thanatos_get_stats(&top, &capacity, &events, &dropped);
      printf("OK top=%u capacity=%u events=%llu dropped=%llu\n", (unsigned)top,
             (unsigned)capacity, events, dropped);
      fflush(stdout);
      continue;
    }
    if (len >= 6 && line[0] == 'R' && line[1] == 'E' && line[2] == 'D' &&
        line[3] == 'U' && line[4] == 'C' && line[5] == 'E' &&
        (len == 6 || line[6] == ' ' || line[6] == '\t')) {
      const char *dag = line + 6;
      size_t dag_len = len - 6;
      while (dag_len > 0 && (*dag == ' ' || *dag == '\t')) {
        dag++;
        dag_len--;
      }
      if (dag_len == 0) {
        printf("ERR REDUCE requires DAG payload\n");
        fflush(stdout);
        continue;
      }
      size_t end_idx = 0;
      uint32_t root = parse_dag(dag, dag_len, &end_idx);
      if (root == EMPTY) {
        printf("ERR parse error\n");
        fflush(stdout);
        continue;
      }
      uint32_t result = thanatos_reduce_to_normal_form(root);
      if (result == EMPTY) {
        printf("ERR reduction error\n");
        fflush(stdout);
        continue;
      }
      size_t n = unparse_dag(result, outbuf, sizeof(outbuf));
      if (n == (size_t)-1) {
        printf("ERR result too large\n");
        fflush(stdout);
        continue;
      }
      if (n == 0) {
        printf("ERR runtime-node-kind\n");
        fflush(stdout);
        continue;
      }
      printf("OK %s\n", outbuf);
      fflush(stdout);
      continue;
    }

    printf("ERR unknown command\n");
    fflush(stdout);
  }

  free(line);
  thanatos_shutdown();
  return 0;
}

int main(int argc, char **argv) {
  uint32_t num_workers = default_num_workers();
  uint32_t arena_capacity = 1 << 20;
  int use_dag = 0;
  int daemon = 0;
  int arg_idx = 1;

  /* Consume flags in any order; remainder are positional (workers,
   * arena_capacity). */
  while (arg_idx < argc) {
    if (strcmp(argv[arg_idx], "--daemon") == 0) {
      daemon = 1;
      arg_idx++;
    } else if (strcmp(argv[arg_idx], "--dag") == 0) {
      use_dag = 1;
      arg_idx++;
    } else
      break;
  }

  if (arg_idx < argc)
    num_workers = (uint32_t)atoi(argv[arg_idx]);
  if (arg_idx + 1 < argc)
    arena_capacity = (uint32_t)atoi(argv[arg_idx + 1]);

  if (daemon) {
    /* Daemon mode: clean protocol channel; stdout pump disabled. */
    return run_daemon_mode(num_workers, arena_capacity);
  }

  /* Batch mode: legacy behavior; stdout may include program output (pump
   * enabled). Read all stdin, then process lines. */
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

  int ret =
      run_batch_mode(num_workers, arena_capacity, input, input_len, use_dag);
  free(input);
  return ret;
}
