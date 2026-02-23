#define _DEFAULT_SOURCE
#include "ski_io.h"

/* Parser state: buf, len, and current index. */
typedef struct {
  const char *buf;
  size_t len;
  size_t idx;
} ParseState;

static void skip_ws(ParseState *s) {
  while (s->idx < s->len && (s->buf[s->idx] == ' ' || s->buf[s->idx] == '\t' ||
                             s->buf[s->idx] == '\r' || s->buf[s->idx] == '\n'))
    s->idx++;
}

static int peek(ParseState *s) {
  skip_ws(s);
  if (s->idx >= s->len)
    return -1;
  return (unsigned char)s->buf[s->idx];
}

static void consume(ParseState *s) {
  if (s->idx < s->len)
    s->idx++;
}

/* Map single char to ARENA_SYM_*. Returns 0 if not a terminal. */
static uint32_t char_to_sym(int c) {
  switch (c) {
  case 'S':
  case 's':
    return ARENA_SYM_S;
  case 'K':
  case 'k':
    return ARENA_SYM_K;
  case 'I':
  case 'i':
    return ARENA_SYM_I;
  case 'B':
  case 'b':
    return ARENA_SYM_B;
  case 'C':
  case 'c':
    return ARENA_SYM_C;
  case 'P':
  case 'p':
    return ARENA_SYM_SPRIME;
  case 'Q':
  case 'q':
    return ARENA_SYM_BPRIME;
  case 'R':
  case 'r':
    return ARENA_SYM_CPRIME;
  case ',':
    return ARENA_SYM_READ_ONE;
  case '.':
    return ARENA_SYM_WRITE_ONE;
  default:
    return 0;
  }
}

static int is_atom_start(int c) { return c == '(' || char_to_sym(c) != 0; }

static uint32_t parse_seq(ParseState *s);

/* Parse one atomic expression: terminal or ( seq ). Returns EMPTY on error. */
static uint32_t parse_atomic(ParseState *s) {
  int c = peek(s);
  if (c == -1)
    return EMPTY;
  if (c == '(') {
    consume(s);
    uint32_t inner = parse_seq(s);
    if (inner == EMPTY)
      return EMPTY;
    skip_ws(s);
    if (s->idx >= s->len || s->buf[s->idx] != ')')
      return EMPTY;
    consume(s);
    return inner;
  }
  uint32_t sym = char_to_sym(c);
  if (sym == 0)
    return EMPTY;
  consume(s);
  return allocTerminal(sym);
}

/* Parse a sequence (left-assoc application): atom atom ... */
static uint32_t parse_seq(ParseState *s) {
  uint32_t cur = parse_atomic(s);
  if (cur == EMPTY)
    return EMPTY;
  while (1) {
    int c = peek(s);
    if (c == -1 || !is_atom_start(c))
      return cur;
    uint32_t next = parse_atomic(s);
    if (next == EMPTY)
      return EMPTY;
    cur = allocCons(cur, next);
  }
}

uint32_t parse_ski(const char *buf, size_t len, size_t *end_idx) {
  ParseState s = {.buf = buf, .len = len, .idx = 0};
  uint32_t root = parse_seq(&s);
  if (end_idx)
    *end_idx = s.idx;
  return root;
}

/* Map ARENA_SYM_* to output character. */
static char sym_to_char(uint32_t sym) {
  switch (sym) {
  case ARENA_SYM_S:
    return 'S';
  case ARENA_SYM_K:
    return 'K';
  case ARENA_SYM_I:
    return 'I';
  case ARENA_SYM_READ_ONE:
    return ',';
  case ARENA_SYM_WRITE_ONE:
    return '.';
  case ARENA_SYM_B:
    return 'B';
  case ARENA_SYM_C:
    return 'C';
  case ARENA_SYM_SPRIME:
    return 'P';
  case ARENA_SYM_BPRIME:
    return 'Q';
  case ARENA_SYM_CPRIME:
    return 'R';
  default:
    return '?';
  }
}

/* Recursive unparse; returns bytes written. */
static size_t unparse_ski_rec(uint32_t node_id, char *buf, size_t capacity,
                              size_t written) {
  if (node_id == EMPTY || capacity <= written)
    return written;
  uint32_t kind = kindOf(node_id);
  if (kind == ARENA_KIND_TERMINAL) {
    if (written + 2 > capacity)
      return written;
    buf[written++] = sym_to_char(symOf(node_id));
    return written;
  }
  if (kind == ARENA_KIND_NON_TERM) {
    uint32_t l = leftOf(node_id), r = rightOf(node_id);
    if (written + 1 > capacity)
      return written;
    buf[written++] = '(';
    written = unparse_ski_rec(l, buf, capacity, written);
    if (written + 1 > capacity)
      return written;
    buf[written++] = ' ';
    written = unparse_ski_rec(r, buf, capacity, written);
    if (written + 1 > capacity)
      return written;
    buf[written++] = ')';
    return written;
  }
  /* Suspension/continuation: treat as application for display. */
  if (kind == ARENA_KIND_SUSPENSION || kind == ARENA_KIND_CONTINUATION) {
    uint32_t l = leftOf(node_id), r = rightOf(node_id);
    if (written + 1 > capacity)
      return written;
    buf[written++] = '(';
    written = unparse_ski_rec(l, buf, capacity, written);
    if (written + 1 > capacity)
      return written;
    buf[written++] = ' ';
    written = unparse_ski_rec(r, buf, capacity, written);
    if (written + 1 > capacity)
      return written;
    buf[written++] = ')';
    return written;
  }
  return written;
}

size_t unparse_ski(uint32_t node_id, char *buf, size_t capacity) {
  if (!buf || capacity == 0)
    return 0;
  if (node_id == EMPTY) {
    buf[0] = '\0';
    return 0;
  }
  size_t n = unparse_ski_rec(node_id, buf, capacity, 0);
  if (n < capacity)
    buf[n] = '\0';
  return n;
}
