#include "session.h"
#include "arena.h"
#include "ski_io.h"
#include "thanatos.h"
#include "util.h"
#include <fcntl.h>
#include <stdarg.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <unistd.h>

#define MAX_STEPS 0xffffffffu

void thanatos_session_init(ThanatosSession *s, bool is_daemon, bool use_dag,
                           FILE *stdout_stream) {
  db_init(&s->out);
  s->is_daemon = is_daemon;
  s->use_dag = use_dag;
  s->stdout_stream = stdout_stream;
}

void thanatos_session_free(ThanatosSession *s) { db_free(&s->out); }

static void session_printf(ThanatosSession *s, const char *fmt, ...) {
  va_list args;
  va_start(args, fmt);
  vfprintf(s->stdout_stream, fmt, args);
  va_end(args);
}

static void session_fflush(ThanatosSession *s) { fflush(s->stdout_stream); }

static bool command_matches(const char *line, size_t len, const char *command,
                            size_t command_len) {
  return len >= command_len && memcmp(line, command, command_len) == 0 &&
         (len == command_len || line[command_len] == ' ' ||
          line[command_len] == '\t');
}

static bool unparse_and_respond(ThanatosSession *s, uint32_t result,
                                const char *protocol_prefix) {
  size_t initial_guess = 1024;
  if (!db_ensure(&s->out, initial_guess))
    return false;

  while (1) {
    size_t n;
    if (s->use_dag) {
      n = unparse_dag(result, s->out.ptr, s->out.cap);
    } else {
      n = unparse_ski(result, s->out.ptr, s->out.cap);
    }

    if (s->use_dag) {
      if (n == (size_t)-1) {
        if (!db_ensure(&s->out, s->out.cap * 2))
          return false;
        continue;
      }
      if (n == 0) {
        session_printf(s, "ERR runtime-control-ptr\n");
        return true;
      }
    } else {
      if (n >= s->out.cap) {
        if (!db_ensure(&s->out, s->out.cap * 2))
          return false;
        continue;
      }
    }

    if (s->is_daemon) {
      if (protocol_prefix && protocol_prefix[0] != '\0') {
        session_printf(s, "%s", protocol_prefix);
      }
      session_printf(s, "%s\n", s->out.ptr);
    } else {
      session_printf(s, "%s\n", s->out.ptr);
    }
    return true;
  }
}

typedef struct {
  uint8_t *buf;
  size_t cap;
  size_t len;
  int error;
} StdoutBuffer;

static void daemon_stdout_handler(uint8_t byte, void *ctx) {
  StdoutBuffer *sb = (StdoutBuffer *)ctx;
  if (sb->error)
    return;
  if (sb->len >= sb->cap) {
    size_t new_cap = sb->cap == 0 ? 1024 : sb->cap * 2;
    uint8_t *new_buf = realloc(sb->buf, new_cap);
    if (!new_buf) {
      sb->error = 1;
      return;
    }
    sb->buf = new_buf;
    sb->cap = new_cap;
  }
  sb->buf[sb->len++] = byte;
}

static int parse_one_path(const char **p_start, char *out, size_t max) {
  const char *start = *p_start;
  while (*start == ' ' || *start == '\t')
    start++;
  if (*start == '\0')
    return 0;

  if (*start == '"') {
    start++;
    size_t i = 0;
    while (*start && *start != '"') {
      if (i >= max - 1)
        return -1;
      out[i++] = *start++;
    }
    out[i] = '\0';
    if (*start == '"')
      start++;
  } else {
    size_t i = 0;
    while (*start && *start != ' ' && *start != '\t') {
      if (i >= max - 1)
        return -1;
      out[i++] = *start++;
    }
    out[i] = '\0';
  }
  *p_start = start;
  return 1;
}

static void handle_quit(ThanatosSession *s) {
  if (s->is_daemon) {
    session_printf(s, "OK\n");
    session_fflush(s);
    exit(0);
  }
}

static void handle_ping(ThanatosSession *s) {
  if (s->is_daemon) {
    session_printf(s, "OK\n");
    session_fflush(s);
  }
}

static void handle_reset(ThanatosSession *s) {
  reset();
  thanatos_reset_stats();
  if (s->is_daemon) {
    session_printf(s, "OK\n");
    session_fflush(s);
  }
}

static void handle_stats(ThanatosSession *s) {
  uint32_t top = 0, capacity = 0;
  unsigned long long events = 0, dropped = 0, total_nodes = 0, total_steps = 0,
                     total_cons_allocs = 0, total_cont_allocs = 0,
                     total_susp_allocs = 0, duplicate_lost_allocs = 0,
                     hashcons_hits = 0, hashcons_misses = 0;
  thanatos_get_stats(&top, &capacity, &total_nodes, &total_steps,
                     &total_cons_allocs, &total_cont_allocs, &total_susp_allocs,
                     &duplicate_lost_allocs, &hashcons_hits, &hashcons_misses,
                     &events, &dropped);
  if (s->is_daemon) {
    session_printf(
        s,
        "OK top=%u capacity=%u total_nodes=%llu total_steps=%llu events=%llu "
        "dropped=%llu total_cons_allocs=%llu total_cont_allocs=%llu "
        "total_susp_allocs=%llu duplicate_lost_allocs=%llu "
        "hashcons_hits=%llu hashcons_misses=%llu\n",
        (unsigned)top, (unsigned)capacity, total_nodes, total_steps, events,
        dropped, total_cons_allocs, total_cont_allocs, total_susp_allocs,
        duplicate_lost_allocs, hashcons_hits, hashcons_misses);
  } else {
    session_printf(s, "top=%u capacity=%u steps=%llu\n", (unsigned)top,
                   (unsigned)capacity, total_steps);
  }
  session_fflush(s);
}

static void handle_reduce(ThanatosSession *s, const char *payload, size_t len) {
  while (len > 0 && (*payload == ' ' || *payload == '\t')) {
    payload++;
    len--;
  }
  if (len == 0) {
    if (s->is_daemon)
      session_printf(s, "ERR REDUCE requires payload\n");
    session_fflush(s);
    return;
  }
  size_t end_idx = 0;
  uint32_t root;
  if (s->use_dag) {
    root = parse_dag(payload, len, &end_idx);
  } else {
    root = parse_ski(payload, len, &end_idx);
  }

  if (root == EMPTY) {
    session_printf(s, s->is_daemon ? "ERR parse error\n" : "parse error\n");
    session_fflush(s);
    return;
  }
  uint32_t result = thanatos_reduce_to_normal_form(root);
  if (result == EMPTY) {
    session_printf(s, s->is_daemon ? "ERR reduction error\n"
                                   : "reduction error\n");
    session_fflush(s);
    return;
  }
  if (!unparse_and_respond(s, result, "OK ")) {
    session_printf(s, "ERR response too large or OOM\n");
  }
  session_fflush(s);
}

static void handle_reduce_io(ThanatosSession *s, const char *line, size_t len) {
  const char *p = line + 9;
  while (*p == ' ' || *p == '\t')
    p++;
  const char *stdin_hex = p;
  while (*p && *p != ' ' && *p != '\t')
    p++;
  size_t stdin_hex_len = (size_t)(p - stdin_hex);
  while (*p == ' ' || *p == '\t')
    p++;
  const char *dag_payload = p;
  size_t dag_len = (size_t)(line + len - dag_payload);

  if (dag_len == 0) {
    session_printf(s, "ERR REDUCE_IO requires <stdin_hex> <dag>\n");
    session_fflush(s);
    return;
  }

  if (stdin_hex_len == 1 && stdin_hex[0] == '-') {
    /* empty stdin */
  } else {
    if (stdin_hex_len % 2 != 0) {
      session_printf(s, "ERR REDUCE_IO hex must be even length\n");
      session_fflush(s);
      return;
    }
    int fail = 0;
    for (size_t i = 0; i < stdin_hex_len; i += 2) {
      int h1 = hex_digit(stdin_hex[i]);
      int h2 = hex_digit(stdin_hex[i + 1]);
      if (h1 < 0 || h2 < 0) {
        fail = 1;
        break;
      }
      arena_stdin_push((uint8_t)((h1 << 4) | h2));
    }
    if (fail) {
      session_printf(s, "ERR REDUCE_IO invalid hex digit\n");
      session_fflush(s);
      return;
    }
  }

  size_t end_idx = 0;
  uint32_t root = parse_dag(dag_payload, dag_len, &end_idx);
  if (root == EMPTY) {
    session_printf(s, "ERR parse error\n");
    session_fflush(s);
    return;
  }

  StdoutBuffer sb = {NULL, 0, 0, 0};
  thanatos_set_stdout_handler(daemon_stdout_handler, &sb);
  uint32_t result = thanatos_reduce_to_normal_form(root);
  thanatos_set_stdout_handler(NULL, NULL);

  if (sb.error) {
    session_printf(s, "ERR stdout buffer allocation failed\n");
    free(sb.buf);
    session_fflush(s);
    return;
  }

  if (result == EMPTY) {
    session_printf(s, "ERR reduction error\n");
    free(sb.buf);
    session_fflush(s);
    return;
  }

  session_printf(s, "OK ");
  if (sb.len == 0) {
    session_printf(s, "-");
  } else {
    for (size_t i = 0; i < sb.len; i++)
      session_printf(s, "%02x", sb.buf[i]);
  }
  session_printf(s, " ");

  if (!unparse_and_respond(s, result, "")) {
    session_printf(s, "ERR response too large or OOM\n");
  }
  free(sb.buf);
  session_fflush(s);
}

static void handle_reduce_file(ThanatosSession *s, const char *line,
                               size_t len) {
  char in_str[1024];
  char out_str[1024];
  const char *p = line + 11;

  int rc1 = parse_one_path(&p, in_str, sizeof(in_str));
  if (rc1 < 0) {
    session_printf(s, "ERR path too long (max 1023 chars)\n");
    session_fflush(s);
    return;
  }
  int rc2 = parse_one_path(&p, out_str, sizeof(out_str));
  if (rc2 < 0) {
    session_printf(s, "ERR path too long (max 1023 chars)\n");
    session_fflush(s);
    return;
  }

  while (*p == ' ' || *p == '\t')
    p++;
  const char *dag_payload = p;
  size_t dag_len = (size_t)(line + len - dag_payload);

  if (dag_len == 0 || rc1 == 0 || rc2 == 0) {
    session_printf(s, "ERR REDUCE_FILE requires <in_path> <out_path> <dag>\n");
    session_fflush(s);
    return;
  }

  int in_fd = open(in_str, O_RDONLY);
  uint8_t *in_map = NULL;
  size_t in_size = 0;
  if (in_fd >= 0) {
    struct stat st;
    if (fstat(in_fd, &st) == 0 && st.st_size > 0) {
      in_size = st.st_size;
      in_map = mmap(NULL, in_size, PROT_READ, MAP_SHARED, in_fd, 0);
      if (in_map == MAP_FAILED) {
        in_map = NULL;
        in_size = 0;
      }
    }
  }

  int out_fd = open(out_str, O_RDWR | O_CREAT | O_TRUNC, 0666);
  if (out_fd < 0) {
    if (in_map)
      munmap(in_map, in_size);
    if (in_fd >= 0)
      close(in_fd);
    session_printf(s, "ERR cannot open output file\n");
    session_fflush(s);
    return;
  }

  size_t max_out_size = 100ULL * 1024 * 1024 * 1024;
  if (ftruncate(out_fd, max_out_size) < 0) {
    if (in_map)
      munmap(in_map, in_size);
    if (in_fd >= 0)
      close(in_fd);
    close(out_fd);
    session_printf(s, "ERR ftruncate output failed\n");
    session_fflush(s);
    return;
  }

  uint8_t *out_map =
      mmap(NULL, max_out_size, PROT_READ | PROT_WRITE, MAP_SHARED, out_fd, 0);
  if (out_map == MAP_FAILED) {
    if (in_map)
      munmap(in_map, in_size);
    if (in_fd >= 0)
      close(in_fd);
    close(out_fd);
    session_printf(s, "ERR mmap output failed\n");
    session_fflush(s);
    return;
  }

  size_t end_idx = 0;
  uint32_t root = parse_dag(dag_payload, dag_len, &end_idx);
  if (root == EMPTY) {
    if (in_map)
      munmap(in_map, in_size);
    munmap(out_map, max_out_size);
    if (in_fd >= 0)
      close(in_fd);
    close(out_fd);
    session_printf(s, "ERR parse error\n");
    session_fflush(s);
    return;
  }

  arena_set_io_mmap(in_map, in_size, out_map, max_out_size);
  uint32_t result = thanatos_reduce_to_normal_form(root);
  size_t written = arena_get_mmap_out_cursor();
  arena_set_io_mmap(NULL, 0, NULL, 0);

  if (in_map)
    munmap(in_map, in_size);
  if (in_fd >= 0)
    close(in_fd);

  if (written > 0)
    msync(out_map, written, MS_SYNC);
  munmap(out_map, max_out_size);
  if (ftruncate(out_fd, written) < 0) {
    fprintf(stderr, "warning: ftruncate failed to trim output\n");
  }
  close(out_fd);

  if (result == EMPTY) {
    session_printf(s, "ERR reduction error\n");
    session_fflush(s);
    return;
  }
  if (!unparse_and_respond(s, result, "OK ")) {
    session_printf(s, "ERR response too large or OOM\n");
  }
  session_fflush(s);
}

static void handle_step(ThanatosSession *s, const char *line, size_t len) {
  const char *p = line + 4;
  while (*p == ' ' || *p == '\t')
    p++;
  if (*p == '\0') {
    session_printf(s, "ERR STEP requires step_count and DAG payload\n");
    session_fflush(s);
    return;
  }
  uint32_t steps = (uint32_t)strtoul(p, (char **)&p, 10);
  while (*p == ' ' || *p == '\t')
    p++;
  if (*p == '\0') {
    session_printf(s, "ERR STEP requires DAG payload\n");
    session_fflush(s);
    return;
  }
  const char *dag_payload = p;
  size_t dag_len = (size_t)(line + len - dag_payload);
  size_t end_idx = 0;
  uint32_t root = parse_dag(dag_payload, dag_len, &end_idx);
  if (root == EMPTY) {
    session_printf(s, "ERR parse error\n");
    session_fflush(s);
    return;
  }
  uint32_t result = thanatos_reduce(root, steps);
  if (result == EMPTY) {
    session_printf(s, "ERR reduction error\n");
    session_fflush(s);
    return;
  }
  if (!unparse_and_respond(s, result, "OK ")) {
    session_printf(s, "ERR response too large or OOM\n");
  }
  session_fflush(s);
}

void thanatos_session_handle_line(ThanatosSession *s, const char *line,
                                  size_t len) {
  if (command_matches(line, len, "QUIT", 4)) {
    handle_quit(s);
  } else if (command_matches(line, len, "PING", 4)) {
    handle_ping(s);
  } else if (command_matches(line, len, "RESET", 5)) {
    handle_reset(s);
  } else if (command_matches(line, len, "STATS", 5)) {
    handle_stats(s);
  } else if (command_matches(line, len, "REDUCE", 6)) {
    handle_reduce(s, line + 6, len - 6);
  } else if (command_matches(line, len, "REDUCE_IO", 9)) {
    handle_reduce_io(s, line, len);
  } else if (command_matches(line, len, "REDUCE_FILE", 11)) {
    handle_reduce_file(s, line, len);
  } else if (command_matches(line, len, "STEP", 4)) {
    handle_step(s, line, len);
  } else {
    /* If no command prefix and not strictly daemon, treat as naked REDUCE. */
    if (!s->is_daemon) {
      handle_reduce(s, line, len);
    } else {
      session_printf(s, "ERR unknown command\n");
      session_fflush(s);
    }
  }
}
