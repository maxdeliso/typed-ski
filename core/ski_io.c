#include "ski_io.h"
#include "util.h"
#include <stdarg.h>
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
  case 'L':
  case 'l':
    return ARENA_SYM_LT_U8;
  case 'D':
  case 'd':
    return ARENA_SYM_DIV_U8;
  case 'M':
  case 'm':
    return ARENA_SYM_MOD_U8;
  case 'A':
  case 'a':
    return ARENA_SYM_ADD_U8;
  case 'O':
  case 'o':
    return ARENA_SYM_SUB_U8;
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
  case ARENA_SYM_LT_U8:
    return 'L';
  case ARENA_SYM_DIV_U8:
    return 'D';
  case ARENA_SYM_MOD_U8:
    return 'M';
  case ARENA_SYM_ADD_U8:
    return 'A';
  case ARENA_SYM_SUB_U8:
    return 'O';
  default:
    return '?';
  }
}

/* Recursive unparse; returns bytes written. */
static size_t unparse_ski_rec(uint32_t node_id, char *buf, size_t capacity,
                              size_t written) {
  if (node_id == EMPTY || capacity <= written)
    return written;
  if (is_control_ptr(node_id))
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

/* Map single char to ARENA_SYM_* for DAG terminal tokens. Returns 0 if not a
 * DAG terminal. */
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
  case 'L':
    return ARENA_SYM_LT_U8;
  case 'D':
    return ARENA_SYM_DIV_U8;
  case 'M':
    return ARENA_SYM_MOD_U8;
  case 'A':
    return ARENA_SYM_ADD_U8;
  case 'O':
    return ARENA_SYM_SUB_U8;
  default:
    return 0;
  }
}

static bool parse_hex_byte(const char *p, uint8_t *out) {
  int h1 = hex_digit(p[0]);
  int h2 = hex_digit(p[1]);
  if (h1 >= 0 && h2 >= 0) {
    *out = (uint8_t)((h1 << 4) | h2);
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

  /* Terminal: single char */
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
    s->idx++;
    const char *end = s->buf + s->len;
    uint32_t L, R;

    skip_ws(s);
    const char *p = s->buf + s->idx;
    if (p >= end || !parse_u32_dec(p, end, &L))
      return false;
    while (s->idx < s->len && s->buf[s->idx] >= '0' && s->buf[s->idx] <= '9')
      s->idx++;

    skip_ws(s);
    if (s->idx >= s->len || s->buf[s->idx] != ',')
      return false;
    s->idx++;

    skip_ws(s);
    p = s->buf + s->idx;
    if (p >= end || !parse_u32_dec(p, end, &R))
      return false;
    while (s->idx < s->len && s->buf[s->idx] >= '0' && s->buf[s->idx] <= '9')
      s->idx++;

    tok->kind = DAG_TOK_APP;
    tok->sym_or_left = L;
    tok->right = R;
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
      if (count > 1024 * 1024) {
        fprintf(stderr, "parse_dag: token count exceeds limit (1M tokens)\n");
        return EMPTY;
      }
    }
    skip_ws(&scan);
    if (scan.idx != len) {
      fprintf(stderr,
              "parse_dag: scan error (trailing garbage or incomplete parse at "
              "idx %zu/%zu)\n",
              scan.idx, len);
      return EMPTY;
    }
  }

  if (count == 0)
    return EMPTY;

  uint32_t *mapped = (uint32_t *)malloc(count * sizeof(uint32_t));
  if (!mapped) {
    fprintf(stderr, "parse_dag: malloc failed for %zu tokens\n", count);
    return EMPTY;
  }

  for (size_t i = 0; i < count; i++) {
    DagToken tok;
    if (!parse_dag_token(&s, &tok)) {
      fprintf(stderr, "parse_dag: failed to parse token %zu (pass 2)\n", i);
      free(mapped);
      return EMPTY;
    }
    if (tok.kind == DAG_TOK_TERMINAL) {
      mapped[i] = allocTerminal(tok.sym_or_left);
    } else if (tok.kind == DAG_TOK_U8) {
      mapped[i] = allocU8((uint8_t)tok.sym_or_left);
    } else {
      uint32_t L = tok.sym_or_left, R = tok.right;
      if (L >= (uint32_t)i || R >= (uint32_t)i) {
        fprintf(stderr,
                "parse_dag: invalid application @%u,%u (forward ref or OOB) at "
                "token %zu\n",
                L, R, i);
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

/* Ensure table has room for one more; rehash if needed. Returns NULL on alloc
 * failure or if safety limit is exceeded. */
static DagHtEntry *dag_ht_ensure(DagHtEntry *tbl, uint32_t *cap,
                                 uint32_t count) {
  uint32_t c = *cap;
  if (count < (c * 3u) / 4u)
    return tbl;
  uint32_t new_cap = c * 2;
  if (new_cap < 64u)
    new_cap = 64u;

  if (new_cap > 16 * 1024 * 1024) { /* Safety trap: 16M entries */
    fprintf(stderr, "dag_ht_ensure: hash table exceeds safety limit\n");
    return NULL;
  }

  DagHtEntry *new_tbl = (DagHtEntry *)malloc(new_cap * sizeof(DagHtEntry));
  if (!new_tbl) {
    fprintf(stderr, "dag_ht_ensure: malloc failed for %u entries\n", new_cap);
    return NULL;
  }
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

typedef struct {
  char *buf;
  size_t capacity;
  size_t written;
  DagHtEntry *ht;
  uint32_t ht_cap;
  uint32_t ht_count;
  uint32_t next_local;
  DagExportFrame *stack;
  size_t stack_cap;
  size_t stack_len;
} UnparseCtx;

#define DAG_HT_INIT 256
#define DAG_STACK_INIT 64

static void unparse_ctx_free(UnparseCtx *ctx) {
  free(ctx->ht);
  free(ctx->stack);
}

static bool unparse_append(UnparseCtx *ctx, const char *fmt, ...) {
  if (ctx->written >= ctx->capacity)
    return false;
  va_list args;
  va_start(args, fmt);
  int nw = vsnprintf(ctx->buf + ctx->written, ctx->capacity - ctx->written, fmt,
                     args);
  va_end(args);
  if (nw < 0 || (size_t)nw >= ctx->capacity - ctx->written)
    return false;
  ctx->written += (size_t)nw;
  return true;
}

static bool unparse_push(UnparseCtx *ctx, uint32_t node_id, int state) {
  if (ctx->stack_len >= ctx->stack_cap) {
    size_t new_cap = ctx->stack_cap * 2;
    if (new_cap > 16 * 1024 * 1024) { /* Safety trap: 16M frames */
      fprintf(stderr, "unparse_push: stack exceeds safety limit\n");
      return false;
    }
    DagExportFrame *new_stack =
        (DagExportFrame *)realloc(ctx->stack, new_cap * sizeof(DagExportFrame));
    if (!new_stack) {
      fprintf(stderr, "unparse_push: realloc failed for %zu frames\n", new_cap);
      return false;
    }
    ctx->stack = new_stack;
    ctx->stack_cap = new_cap;
  }
  ctx->stack[ctx->stack_len++] = (DagExportFrame){node_id, state};
  return true;
}

static bool unparse_emit_node(UnparseCtx *ctx, uint32_t n) {
  uint32_t k = kindOf(n);
  ctx->ht = dag_ht_ensure(ctx->ht, &ctx->ht_cap, ctx->ht_count + 1);
  if (!ctx->ht)
    return false;
  dag_ht_put(ctx->ht, ctx->ht_cap, n, ctx->next_local++);
  ctx->ht_count++;

  if (k == ARENA_KIND_TERMINAL) {
    return unparse_append(ctx, "%c ", sym_to_char(symOf(n)));
  } else if (k == ARENA_KIND_U8) {
    return unparse_append(ctx, "U%02x ", (unsigned)symOf(n));
  } else {
    uint32_t li = 0, ri = 0;
    dag_ht_get(ctx->ht, ctx->ht_cap, leftOf(n), &li);
    dag_ht_get(ctx->ht, ctx->ht_cap, rightOf(n), &ri);
    return unparse_append(ctx, "@%u,%u ", (unsigned)li, (unsigned)ri);
  }
}

size_t unparse_dag(uint32_t root, char *buf, size_t capacity) {
  if (!buf || capacity == 0)
    return (size_t)-1;
  if (root == EMPTY)
    return 0;

  uint32_t kind = kindOf(root);
  if (!dag_exportable_kind(kind))
    return 0;

  UnparseCtx ctx = {
      .buf = buf,
      .capacity = capacity,
      .written = 0,
      .ht_cap = DAG_HT_INIT,
      .ht_count = 0,
      .next_local = 0,
      .stack_cap = DAG_STACK_INIT,
      .stack_len = 0,
  };

  ctx.ht = (DagHtEntry *)malloc(ctx.ht_cap * sizeof(DagHtEntry));
  if (!ctx.ht)
    return 0;
  for (uint32_t i = 0; i < ctx.ht_cap; i++)
    ctx.ht[i].key = DAG_HT_EMPTY;

  ctx.stack = (DagExportFrame *)malloc(ctx.stack_cap * sizeof(DagExportFrame));
  if (!ctx.stack) {
    free(ctx.ht);
    return 0;
  }

  if (!unparse_push(&ctx, root, DAG_EXPORT_ENTER)) {
    unparse_ctx_free(&ctx);
    return 0;
  }

  while (ctx.stack_len > 0) {
    DagExportFrame *f = &ctx.stack[ctx.stack_len - 1];
    uint32_t n = f->node_id;
    uint32_t k = kindOf(n);

    if (f->state == DAG_EXPORT_ENTER) {
      uint32_t existing;
      if (dag_ht_get(ctx.ht, ctx.ht_cap, n, &existing)) {
        ctx.stack_len--;
        continue;
      }

      if (!dag_exportable_kind(k)) {
        unparse_ctx_free(&ctx);
        return 0;
      }

      if (k == ARENA_KIND_TERMINAL || k == ARENA_KIND_U8) {
        f->state = DAG_EXPORT_EMIT;
        continue;
      }

      /* NON_TERM: replace current ENTER with EMIT, then push R ENTER, then L
       * ENTER */
      f->state = DAG_EXPORT_EMIT;
      uint32_t l = leftOf(n), r = rightOf(n);
      if (!unparse_push(&ctx, r, DAG_EXPORT_ENTER)) {
        unparse_ctx_free(&ctx);
        return 0;
      }
      if (!unparse_push(&ctx, l, DAG_EXPORT_ENTER)) {
        unparse_ctx_free(&ctx);
        return 0;
      }
      continue;
    }

    /* EMIT */
    ctx.stack_len--;
    if (!unparse_emit_node(&ctx, n)) {
      unparse_ctx_free(&ctx);
      return (size_t)-1;
    }
  }

  if (ctx.written > 0 && ctx.buf[ctx.written - 1] == ' ')
    ctx.written--;
  if (ctx.written < ctx.capacity)
    ctx.buf[ctx.written] = '\0';

  size_t final_written = ctx.written;
  unparse_ctx_free(&ctx);
  return final_written;
}
