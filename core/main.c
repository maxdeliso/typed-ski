#include "arena.h"
#include "session.h"
#include "ski_io.h"
#include "thanatos.h"
#include "util.h"
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#define INITIAL_LINE_CAP 1024

static uint32_t default_num_workers(void) {
  long n = sysconf(_SC_NPROCESSORS_ONLN);
  if (n > 0 && n <= 0xffffffffu)
    return (uint32_t)n;
  return 4;
}

int main(int argc, char **argv) {
  uint32_t num_workers = default_num_workers();
  uint32_t arena_capacity = 1 << 20;
  int use_dag = 0;
  int daemon_mode = 0;
  const char *stdin_file = NULL;
  int arg_idx = 1;

  while (arg_idx < argc) {
    if (strcmp(argv[arg_idx], "--daemon") == 0) {
      daemon_mode = 1;
      arg_idx++;
    } else if (strcmp(argv[arg_idx], "--dag") == 0) {
      use_dag = 1;
      arg_idx++;
    } else if (strcmp(argv[arg_idx], "--stdin-file") == 0) {
      arg_idx++;
      if (arg_idx >= argc) {
        fprintf(stderr, "--stdin-file requires a path\n");
        return 1;
      }
      stdin_file = argv[arg_idx++];
    } else
      break;
  }

  if (arg_idx < argc) {
    if (!parse_u32_arg(argv[arg_idx], &num_workers)) {
      fprintf(stderr, "invalid worker count: %s\n", argv[arg_idx]);
      return 1;
    }
    arg_idx++;
  }
  if (arg_idx < argc) {
    if (!parse_u32_arg(argv[arg_idx], &arena_capacity)) {
      fprintf(stderr, "invalid arena capacity: %s\n", argv[arg_idx]);
      return 1;
    }
  }

  int runtime_stdin_fd = -1;
  if (stdin_file) {
    runtime_stdin_fd = open(stdin_file, O_RDONLY | O_NONBLOCK);
    if (runtime_stdin_fd < 0) {
      fprintf(stderr, "cannot open --stdin-file %s\n", stdin_file);
      return 1;
    }
  }

  if (daemon_mode) {
    use_dag = 1;
  }

  ThanatosConfig config = {
      .num_workers = num_workers,
      .arena_capacity = arena_capacity,
      .stdin_fd = runtime_stdin_fd,
  };
  thanatos_init(config);
  thanatos_start_threads(!daemon_mode);

  ThanatosSession session;
  thanatos_session_init(&session, daemon_mode, use_dag, stdout);

  char *line = NULL;
  size_t line_cap = 0;
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
    if (len == 0)
      continue;

    thanatos_session_handle_line(&session, line, len);
  }

  free(line);
  thanatos_session_free(&session);
  thanatos_shutdown();
  return 0;
}
