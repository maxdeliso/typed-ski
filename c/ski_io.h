#ifndef SKI_IO_H
#define SKI_IO_H

#include "arena.h"
#include <stddef.h>

/* Parse a combinator expression from string. Same format as parseSKI in
 * lib/parser/ski.ts: terminals S, K, I, B, C, P, Q, R, ',', '.'; applications
 * as ( left right ) or space-separated. Returns root node id or EMPTY on parse
 * error. *end_idx is set to offset past consumed input. */
uint32_t parse_ski(const char *buf, size_t len, size_t *end_idx);

/* Write a combinator expression to a buffer in the same format (unparseSKI
 * style). Returns number of chars written, or 0 on error. Caller provides buf
 * and capacity. */
size_t unparse_ski(uint32_t node_id, char *buf, size_t capacity);

#endif
