#include "ski_io.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

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
  case 'E':
  case 'e':
    return ARENA_SYM_EQ_U8;
  default:
    return 0;
  }
}
static uint32_t parse_u8_literal(ParseState *s) {
  if (s->idx + 4 > s->len || s->buf[s->idx] != '#' ||
      s->buf[s->idx + 1] != 'u' || s->buf[s->idx + 2] != '8' ||
      s->buf[s->idx + 3] != '(')
    return EMPTY;
  s->idx += 4;
  skip_ws(s);
  unsigned val = 0;
  int digits = 0;
  while (s->idx < s->len && s->buf[s->idx] >= '0' && s->buf[s->idx] <= '9') {
    val = val * 10 + (unsigned)(s->buf[s->idx] - '0');
    if (val > 255)
      return EMPTY;
    s->idx++;
    digits++;
  }
  if (digits == 0 || s->idx >= s->len || s->buf[s->idx] != ')')
    return EMPTY;
  s->idx++;
  return allocU8((uint8_t)val);
}

/* is_atom_start: allow # for #u8(n) */
static int is_atom_start(int c) {
  return c == '(' || c == '#' || char_to_sym(c) != 0;
}

static uint32_t parse_seq(ParseState *s);

/* Parse one atomic expression: terminal, #u8(n), or ( seq ). Returns EMPTY on
 * error. */
static uint32_t parse_atomic(ParseState *s) {
  int c = peek(s);
  if (c == -1)
    return EMPTY;
  if (c == '#') {
    return parse_u8_literal(s);
  }
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
  case ARENA_SYM_EQ_U8:
    return 'E';
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
  if (kind == ARENA_KIND_U8) {
    int n = snprintf(buf + written, (int)(capacity - written), "#u8(%u)",
                     (unsigned)symOf(node_id));
    if (n < 0 || (size_t)n >= capacity - written)
      return written;
    return written + (size_t)n;
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

/* --- DAG wire codec --- */

static int is_dag_ws(int c) {
  return c == ' ' || c == '\t' || c == '\r' || c == '\n';
}

/* Map single char to ARENA_SYM_* for DAG terminal tokens. Returns 0 if not a
 * DAG terminal. DAG uses exact S K I B C P Q R , . E (no lowercase). */
static uint32_t dag_char_to_sym(int c) {
  switch (c) {
  case 'S':
    return ARENA_SYM_S;
  case 'K':
    return ARENA_SYM_K;
  case 'I':
    return ARENA_SYM_I;
  case 'B':
    return ARENA_SYM_B;
  case 'C':
    return ARENA_SYM_C;
  case 'P':
    return ARENA_SYM_SPRIME;
  case 'Q':
    return ARENA_SYM_BPRIME;
  case 'R':
    return ARENA_SYM_CPRIME;
  case ',':
    return ARENA_SYM_READ_ONE;
  case '.':
    return ARENA_SYM_WRITE_ONE;
  case 'E':
    return ARENA_SYM_EQ_U8;
  default:
    return 0;
  }
}

static bool parse_hex_byte(const char *p, uint8_t *out) {
  if (p[0] >= '0' && p[0] <= '9' && p[1] >= '0' && p[1] <= '9') {
    *out = (uint8_t)((p[0] - '0') * 16 + (p[1] - '0'));
    return true;
  }
  if (p[0] >= '0' && p[0] <= '9' && p[1] >= 'A' && p[1] <= 'F') {
    *out = (uint8_t)((p[0] - '0') * 16 + (p[1] - 'A' + 10));
    return true;
  }
  if (p[0] >= 'A' && p[0] <= 'F' && p[1] >= '0' && p[1] <= '9') {
    *out = (uint8_t)((p[0] - 'A' + 10) * 16 + (p[1] - '0'));
    return true;
  }
  if (p[0] >= 'A' && p[0] <= 'F' && p[1] >= 'A' && p[1] <= 'F') {
    *out = (uint8_t)((p[0] - 'A' + 10) * 16 + (p[1] - 'A' + 10));
    return true;
  }
  if (p[0] >= 'a' && p[0] <= 'f' && p[1] >= 'a' && p[1] <= 'f') {
    *out = (uint8_t)((p[0] - 'a' + 10) * 16 + (p[1] - 'a' + 10));
    return true;
  }
  if (p[0] >= 'a' && p[0] <= 'f' && p[1] >= '0' && p[1] <= '9') {
    *out = (uint8_t)((p[0] - 'a' + 10) * 16 + (p[1] - '0'));
    return true;
  }
  if (p[0] >= '0' && p[0] <= '9' && p[1] >= 'a' && p[1] <= 'f') {
    *out = (uint8_t)((p[0] - '0') * 16 + (p[1] - 'a' + 10));
    return true;
  }
  return false;
}

static bool parse_u32_dec(const char *start, const char *end, uint32_t *out) {
  if (start >= end)
    return false;
  uint32_t val = 0;
  const char *p = start;
  while (p < end && *p >= '0' && *p <= '9') {
    uint32_t digit = (uint32_t)(*p - '0');
    if (val > (0xffffffffu - digit) / 10)
      return false;
    val = val * 10 + digit;
    p++;
  }
  if (p == start)
    return false;
  *out = val;
  return true;
}

typedef enum {
  DAG_TOK_TERMINAL,
  DAG_TOK_U8,
  DAG_TOK_APP,
} DagTokKind;

typedef struct {
  DagTokKind kind;
  uint32_t sym_or_left; /* terminal/u8: sym; app: left index */
  uint32_t right;       /* app only: right index */
} DagToken;

/* Scan one DAG token from s->buf[s->idx..]. On success advance s->idx and set
 * *tok. Return true on success, false on error or end of input. */
static bool parse_dag_token(ParseState *s, DagToken *tok) {
  skip_ws(s);
  if (s->idx >= s->len)
    return false;

  const char *start = s->buf + s->idx;
  int c = (unsigned char)start[0];

  /* Terminal: single char S K I B C P Q R , . E */
  if (dag_char_to_sym(c) != 0) {
    tok->kind = DAG_TOK_TERMINAL;
    tok->sym_or_left = dag_char_to_sym(c);
    tok->right = 0;
    s->idx++;
    return true;
  }

  /* Uxx: two hex digits */
  if (c == 'U' && s->idx + 3 <= s->len) {
    uint8_t byte;
    if (parse_hex_byte(start + 1, &byte)) {
      tok->kind = DAG_TOK_U8;
      tok->sym_or_left = byte;
      tok->right = 0;
      s->idx += 3;
      return true;
    }
  }

  /* @L,R */
  if (c == '@' && s->idx + 1 < s->len) {
    const char *p = start + 1;
    const char *end = s->buf + s->len;
    while (p < end && is_dag_ws((unsigned char)*p))
      p++;
    if (p >= end || *p < '0' || *p > '9')
      return false;
    const char *left_start = p;
    while (p < end && *p >= '0' && *p <= '9')
      p++;
    uint32_t left_idx;
    if (!parse_u32_dec(left_start, p, &left_idx))
      return false;
    while (p < end && is_dag_ws((unsigned char)*p))
      p++;
    if (p >= end || *p != ',')
      return false;
    p++;
    while (p < end && is_dag_ws((unsigned char)*p))
      p++;
    if (p >= end || *p < '0' || *p > '9')
      return false;
    const char *right_start = p;
    while (p < end && *p >= '0' && *p <= '9')
      p++;
    uint32_t right_idx;
    if (!parse_u32_dec(right_start, p, &right_idx))
      return false;
    tok->kind = DAG_TOK_APP;
    tok->sym_or_left = left_idx;
    tok->right = right_idx;
    s->idx = (size_t)(p - s->buf);
    return true;
  }

  return false;
}

uint32_t parse_dag(const char *buf, size_t len, size_t *end_idx) {
  if (!buf)
    return EMPTY;
  ParseState s = {.buf = buf, .len = len, .idx = 0};
  skip_ws(&s);
  if (s.idx >= s.len)
    return EMPTY;

  size_t count = 0;
  {
    ParseState scan = s;
    DagToken tok;
    while (parse_dag_token(&scan, &tok)) {
      count++;
      if (count > 1024 * 1024)
        return EMPTY;
    }
    skip_ws(&scan);
    if (scan.idx != len)
      return EMPTY;
  }

  if (count == 0)
    return EMPTY;

  uint32_t *mapped = (uint32_t *)malloc(count * sizeof(uint32_t));
  if (!mapped)
    return EMPTY;

  for (size_t i = 0; i < count; i++) {
    DagToken tok;
    if (!parse_dag_token(&s, &tok)) {
      free(mapped);
      return EMPTY;
    }
    if (tok.kind == DAG_TOK_TERMINAL) {
      mapped[i] = allocTerminal(tok.sym_or_left);
    } else if (tok.kind == DAG_TOK_U8) {
      mapped[i] = allocU8((uint8_t)tok.sym_or_left);
    } else {
      uint32_t L = tok.sym_or_left, R = tok.right;
      if (L >= i || R >= i) {
        free(mapped);
        return EMPTY;
      }
      mapped[i] = allocCons(mapped[L], mapped[R]);
    }
  }

  uint32_t root = mapped[count - 1];
  if (end_idx)
    *end_idx = s.idx;
  free(mapped);
  return root;
}

/* Export: only these kinds are allowed. */
static int dag_exportable_kind(uint32_t kind) {
  return kind == ARENA_KIND_TERMINAL || kind == ARENA_KIND_U8 ||
         kind == ARENA_KIND_NON_TERM;
}

/* Open-addressed hash table: arena_id -> local_index. O(1) lookup/insert. */
#define DAG_HT_EMPTY 0xffffffffu

typedef struct {
  uint32_t key;
  uint32_t val;
} DagHtEntry;

static uint32_t dag_ht_hash(uint32_t key, uint32_t mask) {
  return (key * 2654435761u) & mask;
}

static int dag_ht_get(DagHtEntry *tbl, uint32_t cap, uint32_t key,
                      uint32_t *out_val) {
  uint32_t mask = cap - 1;
  uint32_t i = dag_ht_hash(key, mask);
  while (tbl[i].key != DAG_HT_EMPTY) {
    if (tbl[i].key == key) {
      *out_val = tbl[i].val;
      return 1;
    }
    i = (i + 1) & mask;
  }
  return 0;
}

/* Ensure table has room for one more; rehash if needed. Returns 0 on alloc
 * failure. */
static DagHtEntry *dag_ht_ensure(DagHtEntry *tbl, uint32_t *cap,
                                 uint32_t count) {
  uint32_t c = *cap;
  if (count < (c * 3u) / 4u)
    return tbl;
  uint32_t new_cap = c * 2;
  if (new_cap < 64u)
    new_cap = 64u;
  DagHtEntry *new_tbl = (DagHtEntry *)malloc(new_cap * sizeof(DagHtEntry));
  if (!new_tbl)
    return NULL;
  for (uint32_t i = 0; i < new_cap; i++)
    new_tbl[i].key = DAG_HT_EMPTY;
  uint32_t mask = new_cap - 1;
  for (uint32_t i = 0; i < c; i++) {
    if (tbl[i].key == DAG_HT_EMPTY)
      continue;
    uint32_t j = dag_ht_hash(tbl[i].key, mask);
    while (new_tbl[j].key != DAG_HT_EMPTY)
      j = (j + 1) & mask;
    new_tbl[j].key = tbl[i].key;
    new_tbl[j].val = tbl[i].val;
  }
  free(tbl);
  *cap = new_cap;
  return new_tbl;
}

static int dag_ht_put(DagHtEntry *tbl, uint32_t cap, uint32_t key,
                      uint32_t val) {
  uint32_t mask = cap - 1;
  uint32_t i = dag_ht_hash(key, mask);
  while (tbl[i].key != DAG_HT_EMPTY && tbl[i].key != key)
    i = (i + 1) & mask;
  tbl[i].key = key;
  tbl[i].val = val;
  return 1;
}

/* Iterative postorder export. state: 0 = ENTER, 1 = EMIT. */
#define DAG_EXPORT_ENTER 0
#define DAG_EXPORT_EMIT 1

typedef struct {
  uint32_t node_id;
  int state;
} DagExportFrame;

#define DAG_HT_INIT 256
#define DAG_STACK_INIT 64

size_t unparse_dag(uint32_t root, char *buf, size_t capacity) {
  if (!buf || capacity == 0)
    return (size_t)-1;
  if (root == EMPTY)
    return 0;

  uint32_t kind = kindOf(root);
  if (!dag_exportable_kind(kind))
    return 0;

  uint32_t ht_cap = DAG_HT_INIT;
  DagHtEntry *ht = (DagHtEntry *)malloc(ht_cap * sizeof(DagHtEntry));
  if (!ht)
    return 0;
  for (uint32_t i = 0; i < ht_cap; i++)
    ht[i].key = DAG_HT_EMPTY;

  DagExportFrame *stack =
      (DagExportFrame *)malloc(DAG_STACK_INIT * sizeof(DagExportFrame));
  size_t stack_cap = DAG_STACK_INIT;
  size_t stack_len = 0;
  if (!stack) {
    free(ht);
    return 0;
  }

  size_t written = 0;
  uint32_t next_local = 0;
  uint32_t ht_count = 0;

  stack[0].node_id = root;
  stack[0].state = DAG_EXPORT_ENTER;
  stack_len = 1;

  while (stack_len > 0) {
    DagExportFrame *f = &stack[stack_len - 1];
    uint32_t n = f->node_id;
    uint32_t k = kindOf(n);

    if (f->state == DAG_EXPORT_ENTER) {
      uint32_t existing;
      if (dag_ht_get(ht, ht_cap, n, &existing)) {
        stack_len--;
        continue;
      }

      if (!dag_exportable_kind(k)) {
        free(ht);
        free(stack);
        return 0;
      }

      if (k == ARENA_KIND_TERMINAL || k == ARENA_KIND_U8) {
        f->state = DAG_EXPORT_EMIT;
        continue;
      }

      /* NON_TERM: push EMIT for self, then right ENTER, then left ENTER */
      f->state = DAG_EXPORT_EMIT;
      uint32_t l = leftOf(n), r = rightOf(n);
      if (stack_len + 2 > stack_cap) {
        size_t new_cap = stack_cap * 2;
        DagExportFrame *new_stack =
            (DagExportFrame *)realloc(stack, new_cap * sizeof(DagExportFrame));
        if (!new_stack) {
          free(ht);
          free(stack);
          return 0;
        }
        stack = new_stack;
        stack_cap = new_cap;
      }
      stack[stack_len - 1] =
          (DagExportFrame){.node_id = n, .state = DAG_EXPORT_EMIT};
      stack[stack_len++] =
          (DagExportFrame){.node_id = r, .state = DAG_EXPORT_ENTER};
      stack[stack_len++] =
          (DagExportFrame){.node_id = l, .state = DAG_EXPORT_ENTER};
      continue;
    }

    /* EMIT */
    stack_len--;
    ht = dag_ht_ensure(ht, &ht_cap, ht_count + 1);
    if (!ht) {
      free(stack);
      return 0;
    }
    dag_ht_put(ht, ht_cap, n, next_local);
    ht_count++;
    next_local++;

    if (k == ARENA_KIND_TERMINAL) {
      char ch = sym_to_char(symOf(n));
      if (written >= capacity) {
        free(ht);
        free(stack);
        return (size_t)-1;
      }
      buf[written++] = ch;
      if (written < capacity)
        buf[written++] = ' ';
    } else if (k == ARENA_KIND_U8) {
      int need = 4 + (written < capacity ? 1 : 0);
      if (written + need > capacity) {
        free(ht);
        free(stack);
        return (size_t)-1;
      }
      int nw = snprintf(buf + written, capacity - written, "U%02x ",
                        (unsigned)symOf(n));
      if (nw < 0 || (size_t)nw >= capacity - written) {
        free(ht);
        free(stack);
        return (size_t)-1;
      }
      written += (size_t)nw;
    } else {
      uint32_t li = 0, ri = 0;
      dag_ht_get(ht, ht_cap, leftOf(n), &li);
      dag_ht_get(ht, ht_cap, rightOf(n), &ri);
      char app_buf[32];
      int nw = snprintf(app_buf, sizeof(app_buf), "@%u,%u ", (unsigned)li,
                        (unsigned)ri);
      if (nw < 0 || (size_t)nw >= (int)sizeof(app_buf) ||
          written + (size_t)nw > capacity) {
        free(ht);
        free(stack);
        return (size_t)-1;
      }
      memcpy(buf + written, app_buf, (size_t)nw);
      written += (size_t)nw;
    }
  }

  if (written > 0 && buf[written - 1] == ' ')
    written--;
  free(ht);
  free(stack);
  if (written < capacity)
    buf[written] = '\0';
  return written;
}
