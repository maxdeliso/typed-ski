#ifdef _WIN32
#ifndef _CRT_SECURE_NO_WARNINGS
#define _CRT_SECURE_NO_WARNINGS
#endif
#endif

#include "arena.h"
#include "host_platform.h"
#include "session.h"
#include "ski_io.h"
#include "thanatos.h"
#include "util.h"
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define INITIAL_LINE_CAP 1024

static uint32_t default_num_workers(void) { return host_cpu_count(); }

int main(int argc, char **argv) {
  uint32_t num_workers = default_num_workers();
  uint32_t arena_capacity = 1 << 20;
  const char *stdin_file = NULL;
  int arg_idx = 1;

  while (arg_idx < argc) {
    if (strcmp(argv[arg_idx], "--stdin-file") == 0) {
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

  const char *trace_dir = getenv("THANATOS_TRACE_DIR");
  uint32_t trace_timeout_ms = 1000;
  const char *trace_timeout_env = getenv("THANATOS_TRACE_TIMEOUT_MS");
  if (trace_timeout_env && trace_timeout_env[0] != "\0"[0]) {
    uint32_t parsed = 0;
    if (!parse_u32_arg(trace_timeout_env, &parsed)) {
      fprintf(stderr, "invalid THANATOS_TRACE_TIMEOUT_MS: %s\n",
              trace_timeout_env);
      return 1;
    }
    trace_timeout_ms = parsed;
  }

  if (stdin_file && !host_path_openable_for_read(stdin_file)) {
    fprintf(stderr, "cannot open --stdin-file %s\n", stdin_file);
    return 1;
  }

  ThanatosConfig config = {
      .num_workers = num_workers,
      .arena_capacity = arena_capacity,
      .stdin_path = stdin_file,
      .trace_dir = trace_dir,
      .trace_timeout_ms = trace_timeout_ms,
  };
  thanatos_init(config);
  thanatos_start_threads(false);

  ThanatosSession session;
  thanatos_session_init(&session, stdout);

  DynamicBuffer line;
  db_init(&line);
  while (1) {
    size_t len = 0;
    if (!db_read_line(stdin, &line, &len))
      break;
    while (len > 0 &&
           (line.ptr[len - 1] == '\r' || line.ptr[len - 1] == ' ' ||
            line.ptr[len - 1] == '\t'))
      len--;
    if (len == 0)
      continue;

    thanatos_session_handle_line(&session, line.ptr, len);
  }

  db_free(&line);
  thanatos_session_free(&session);
  thanatos_shutdown();
  return 0;
}
