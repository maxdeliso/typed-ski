#ifndef SESSION_H
#define SESSION_H

#include "util.h"
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>

typedef struct {
  DynamicBuffer out;
  FILE *stdout_stream;
} ThanatosSession;

void thanatos_session_init(ThanatosSession *s, FILE *stdout_stream);
void thanatos_session_free(ThanatosSession *s);

/**
 * Handle a single command line.
 */
void thanatos_session_handle_line(ThanatosSession *s, const char *line,
                                  size_t len);

#endif
