#ifndef SESSION_H
#define SESSION_H

#include "util.h"
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>

typedef struct {
  DynamicBuffer out;
  bool is_daemon;
  bool use_dag;
  FILE *stdout_stream;
} ThanatosSession;

void thanatos_session_init(ThanatosSession *s, bool is_daemon, bool use_dag,
                           FILE *stdout_stream);
void thanatos_session_free(ThanatosSession *s);

/**
 * Handle a single command line.
 * If not in daemon mode, lines without a command prefix are treated as REDUCE.
 */
void thanatos_session_handle_line(ThanatosSession *s, const char *line,
                                  size_t len);

#endif
