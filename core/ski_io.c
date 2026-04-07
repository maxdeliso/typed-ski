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

enum {
  TOPO_DAG_TERM_WIDTH = 3,
  TOPO_DAG_PTR_WIDTH = 8,
  TOPO_DAG_RECORD_WIDTH = TOPO_DAG_TERM_WIDTH + (TOPO_DAG_PTR_WIDTH * 2),
  TOPO_DAG_RECORD_STRIDE = TOPO_DAG_RECORD_WIDTH + 1,
};

#define TOPO_DAG_NULL_PTR 0xffffffffu

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

static bool parse_u32_hex_fixed(const char *p, size_t width, uint32_t *out) {
  uint32_t value = 0;
  for (size_t i = 0; i < width; i++) {
    int digit = hex_digit((unsigned char)p[i]);
    if (digit < 0)
      return false;
    value = (value << 4) | (uint32_t)digit;
  }
  *out = value;
  return true;
}

static bool parse_topo_pointer(const char *p, uint32_t *out, bool *is_null) {
  static const char null_ptr[] = "FFFFFFFF";
  if (memcmp(p, null_ptr, TOPO_DAG_PTR_WIDTH) == 0) {
    *out = TOPO_DAG_NULL_PTR;
    *is_null = true;
    return true;
  }
  *is_null = false;
  return parse_u32_hex_fixed(p, TOPO_DAG_PTR_WIDTH, out);
}

static bool is_ws_char(char c) {
  return c == ' ' || c == '\t' || c == '\r' || c == '\n';
}

static bool topo_term_is_app(const char *term) {
  return term[0] == '@' && term[1] == '0' && term[2] == '0';
}

static bool topo_term_is_leaf_terminal(const char *term, uint32_t *sym_out) {
  if (term[1] != '0' || term[2] != '0')
    return false;
  uint32_t sym = dag_char_to_sym((unsigned char)term[0]);
  if (sym == 0)
    return false;
  *sym_out = sym;
  return true;
}

uint32_t parse_dag(const char *buf, size_t len, size_t *end_idx) {
  if (!buf)
    return EMPTY;

  size_t start = 0;
  while (start < len && is_ws_char(buf[start]))
    start++;
  size_t end = len;
  while (end > start && is_ws_char(buf[end - 1]))
    end--;

  if (start >= end)
    return EMPTY;

  size_t dag_len = end - start;
  if (dag_len < TOPO_DAG_RECORD_WIDTH)
    return EMPTY;
  if (dag_len > TOPO_DAG_RECORD_WIDTH &&
      ((dag_len - TOPO_DAG_RECORD_WIDTH) % TOPO_DAG_RECORD_STRIDE) != 0) {
    fprintf(stderr, "parse_dag: invalid topoDagWire length %zu\n", dag_len);
    return EMPTY;
  }
  size_t count =
      1 + ((dag_len - TOPO_DAG_RECORD_WIDTH) / TOPO_DAG_RECORD_STRIDE);
  if (count > 1024 * 1024) {
    fprintf(stderr, "parse_dag: token count exceeds limit (1M records)\n");
    return EMPTY;
  }

  for (size_t i = 0; i + 1 < count; i++) {
    size_t sep_idx = (i * TOPO_DAG_RECORD_STRIDE) + TOPO_DAG_RECORD_WIDTH;
    if (buf[start + sep_idx] != '|') {
      fprintf(stderr, "parse_dag: expected record separator at %zu\n",
              start + sep_idx);
      return EMPTY;
    }
  }

  uint32_t *mapped = (uint32_t *)malloc(count * sizeof(uint32_t));
  if (!mapped) {
    fprintf(stderr, "parse_dag: malloc failed for %zu records\n", count);
    return EMPTY;
  }

  for (size_t i = 0; i < count; i++) {
    const char *record = buf + start + (i * TOPO_DAG_RECORD_STRIDE);
    const char *term = record;
    const char *left_field = record + TOPO_DAG_TERM_WIDTH;
    const char *right_field = left_field + TOPO_DAG_PTR_WIDTH;
    uint32_t sym_or_byte = 0;
    uint32_t left_ptr = 0, right_ptr = 0;
    bool left_is_null = false, right_is_null = false;

    if (!parse_topo_pointer(left_field, &left_ptr, &left_is_null) ||
        !parse_topo_pointer(right_field, &right_ptr, &right_is_null)) {
      fprintf(stderr, "parse_dag: invalid pointer field at record %zu\n", i);
      free(mapped);
      return EMPTY;
    }

    if (topo_term_is_leaf_terminal(term, &sym_or_byte)) {
      if (!left_is_null || !right_is_null) {
        fprintf(stderr,
                "parse_dag: terminal record %zu must use null pointers\n", i);
        free(mapped);
        return EMPTY;
      }
      mapped[i] = allocTerminal(sym_or_byte);
      continue;
    }

    uint8_t byte_value = 0;
    if (term[0] == 'U' && parse_hex_byte(term + 1, &byte_value)) {
      if (!left_is_null || !right_is_null) {
        fprintf(stderr, "parse_dag: U8 record %zu must use null pointers\n", i);
        free(mapped);
        return EMPTY;
      }
      mapped[i] = allocU8(byte_value);
      continue;
    }

    if (!topo_term_is_app(term)) {
      fprintf(stderr, "parse_dag: invalid term field at record %zu\n", i);
      free(mapped);
      return EMPTY;
    }

    if (left_is_null || right_is_null) {
      fprintf(stderr,
              "parse_dag: application record %zu cannot use null pointers\n",
              i);
      free(mapped);
      return EMPTY;
    }
    if ((left_ptr % TOPO_DAG_RECORD_STRIDE) != 0 ||
        (right_ptr % TOPO_DAG_RECORD_STRIDE) != 0) {
      fprintf(stderr,
              "parse_dag: application record %zu uses unaligned pointers\n", i);
      free(mapped);
      return EMPTY;
    }

    uint32_t left_index = left_ptr / TOPO_DAG_RECORD_STRIDE;
    uint32_t right_index = right_ptr / TOPO_DAG_RECORD_STRIDE;
    if (left_index >= (uint32_t)i || right_index >= (uint32_t)i) {
      fprintf(stderr,
              "parse_dag: invalid application offsets %08X,%08X at record %zu\n",
              left_ptr, right_ptr, i);
      free(mapped);
      return EMPTY;
    }

    mapped[i] = allocCons(mapped[left_index], mapped[right_index]);
  }

  uint32_t root = mapped[count - 1];
  if (end_idx)
    *end_idx = len;
  free(mapped);
  return root;
}

/* Export: only these kinds are allowed. */
static int dag_exportable_kind(uint32_t kind) {
  return kind == ARENA_KIND_TERMINAL || kind == ARENA_KIND_U8 ||
         kind == ARENA_KIND_NON_TERM;
}

/* Open-addressed hash table: arena_id -> serialized byte offset. O(1)
 * lookup/insert. */
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

static void write_hex8(char *dst, uint32_t value) {
  static const char HEX[] = "0123456789ABCDEF";
  for (int i = TOPO_DAG_PTR_WIDTH - 1; i >= 0; i--) {
    dst[i] = HEX[value & 0xfu];
    value >>= 4;
  }
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
  size_t current_offset = ctx->written;
  if (ctx->written > 0) {
    current_offset += 1;
  }
  if (current_offset > 0xffffffffu) {
    fprintf(stderr, "unparse_emit_node: offset exceeds 32-bit range\n");
    return false;
  }

  size_t required = TOPO_DAG_RECORD_WIDTH + (ctx->written > 0 ? 1 : 0);
  if (ctx->capacity - ctx->written <= required) {
    return false;
  }

  ctx->ht = dag_ht_ensure(ctx->ht, &ctx->ht_cap, ctx->ht_count + 1);
  if (!ctx->ht)
    return false;
  dag_ht_put(ctx->ht, ctx->ht_cap, n, (uint32_t)current_offset);
  ctx->ht_count++;

  if (ctx->written > 0) {
    ctx->buf[ctx->written++] = '|';
  }

  char *record = ctx->buf + ctx->written;
  if (k == ARENA_KIND_TERMINAL) {
    record[0] = sym_to_char(symOf(n));
    record[1] = '0';
    record[2] = '0';
    write_hex8(record + TOPO_DAG_TERM_WIDTH, TOPO_DAG_NULL_PTR);
    write_hex8(record + TOPO_DAG_TERM_WIDTH + TOPO_DAG_PTR_WIDTH,
               TOPO_DAG_NULL_PTR);
  } else if (k == ARENA_KIND_U8) {
    static const char HEX[] = "0123456789ABCDEF";
    uint8_t value = (uint8_t)symOf(n);
    record[0] = 'U';
    record[1] = HEX[(value >> 4) & 0xfu];
    record[2] = HEX[value & 0xfu];
    write_hex8(record + TOPO_DAG_TERM_WIDTH, TOPO_DAG_NULL_PTR);
    write_hex8(record + TOPO_DAG_TERM_WIDTH + TOPO_DAG_PTR_WIDTH,
               TOPO_DAG_NULL_PTR);
  } else {
    uint32_t left_offset = 0, right_offset = 0;
    dag_ht_get(ctx->ht, ctx->ht_cap, leftOf(n), &left_offset);
    dag_ht_get(ctx->ht, ctx->ht_cap, rightOf(n), &right_offset);
    record[0] = '@';
    record[1] = '0';
    record[2] = '0';
    write_hex8(record + TOPO_DAG_TERM_WIDTH, left_offset);
    write_hex8(record + TOPO_DAG_TERM_WIDTH + TOPO_DAG_PTR_WIDTH,
               right_offset);
  }

  ctx->written += TOPO_DAG_RECORD_WIDTH;
  ctx->buf[ctx->written] = '\0';
  return true;
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

    ctx.stack_len--;
    if (!unparse_emit_node(&ctx, n)) {
      unparse_ctx_free(&ctx);
      return (size_t)-1;
    }
  }

  if (ctx.written < ctx.capacity)
    ctx.buf[ctx.written] = '\0';

  size_t final_written = ctx.written;
  unparse_ctx_free(&ctx);
  return final_written;
}
