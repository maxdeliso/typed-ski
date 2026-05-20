/*
 * Tests for DAG wire codec: parse_dag, unparse_dag.
 * Links arena + ski_io only. Run after build: ./bin/dag-codec-test
 */
#include "arena.h"
#include "ski_io.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static int fail(const char *msg) {
  fprintf(stderr, "FAIL: %s\n", msg);
  return 1;
}

static int ok(const char *name) {
  printf("OK: %s\n", name);
  return 0;
}

static void topo_terminal_record(char glyph, char *out, size_t out_cap) {
  int n = snprintf(out, out_cap, "%c00FFFFFFFFFFFFFFFF", glyph);
  if (n < 0 || (size_t)n >= out_cap) {
    abort();
  }
}

static void topo_app_record(uint32_t left_offset, uint32_t right_offset,
                            char *out, size_t out_cap) {
  int n = snprintf(out, out_cap, "@00%08X%08X", left_offset, right_offset);
  if (n < 0 || (size_t)n >= out_cap) {
    abort();
  }
}

/* 1. Export/import round-trip of a DAG with sharing.
 *    Record 0 (S) is shared as the left child of both application records. */
static int test_roundtrip_sharing(void) {
  char s_record[32];
  char k_record[32];
  char i_record[32];
  char first_app[32];
  char root_app[32];
  char dag[128];
  topo_terminal_record('S', s_record, sizeof(s_record));
  topo_terminal_record('K', k_record, sizeof(k_record));
  topo_terminal_record('I', i_record, sizeof(i_record));
  topo_app_record(0, 20, first_app, sizeof(first_app));
  topo_app_record(0, 40, root_app, sizeof(root_app));
  int dag_len = snprintf(dag, sizeof(dag), "%s|%s|%s|%s|%s", s_record,
                         k_record, i_record, first_app, root_app);
  if (dag_len < 0 || (size_t)dag_len >= sizeof(dag))
    return fail("roundtrip sharing: failed to build topoDagWire string");
  size_t len = strlen(dag);
  size_t end_idx = 0;
  uint32_t root = parse_dag(dag, len, &end_idx);
  if (root == EMPTY)
    return fail("roundtrip sharing: parse_dag failed");
  if (end_idx != len)
    return fail("roundtrip sharing: did not consume full input");

  char buf[512];
  size_t n = unparse_dag(root, buf, sizeof(buf));
  if (n == 0 || n == (size_t)-1)
    return fail("roundtrip sharing: unparse_dag failed");

  size_t end2 = 0;
  uint32_t root2 = parse_dag(buf, n, &end2);
  if (root2 == EMPTY)
    return fail("roundtrip sharing: second parse_dag failed");
  char buf2[512];
  size_t n2 = unparse_dag(root2, buf2, sizeof(buf2));
  if (n2 == 0 || n2 == (size_t)-1)
    return fail("roundtrip sharing: second unparse_dag failed");
  if (n != n2 || memcmp(buf, buf2, n) != 0)
    return fail("roundtrip sharing: round-trip string mismatch");
  return ok("roundtrip DAG with sharing");
}

/* 2. Malformed topoDagWire records: forward refs, null child pointers, and
 * misaligned offsets. */
static int test_malformed_refs(void) {
  const char *bad[] = {
      "@0000000000000000",
      "S00FFFFFFFFFFFFFFFF|@0000001400000000",
      "S00FFFFFFFFFFFFFFFF|K00FFFFFFFFFFFFFFFF|@0000002800000000",
      "S00FFFFFFFFFFFFFFFF|K00FFFFFFFFFFFFFFFF|@0000000100000014",
      "@00FFFFFFFFFFFFFFFF",
  };
  for (size_t i = 0; i < sizeof(bad) / sizeof(bad[0]); i++) {
    size_t len = strlen(bad[i]);
    size_t end_idx = 0;
    uint32_t root = parse_dag(bad[i], len, &end_idx);
    if (root != EMPTY) {
      fprintf(stderr,
              "FAIL: malformed refs: expected EMPTY for \"%s\", got root\n",
              bad[i]);
      return 1;
    }
  }
  return ok("malformed topoDagWire pointers");
}

/* 3. Deep left spine: build DAG with many left-associative apps, export
 * iteratively. */
static int test_deep_left_spine(void) {
  static char spine_buf[64 * 1024];
  const size_t depth = 200;
  size_t off = 0;
  size_t remaining = sizeof(spine_buf);
  {
    char s_record[32];
    char k_record[32];
    char app_record[32];
    topo_terminal_record('S', s_record, sizeof(s_record));
    topo_terminal_record('K', k_record, sizeof(k_record));
    topo_app_record(0, 20, app_record, sizeof(app_record));
    int n0 = snprintf(spine_buf, remaining, "%s|%s|%s", s_record, k_record,
                      app_record);
    if (n0 < 0 || (size_t)n0 >= remaining) {
      return fail("deep left spine: snprintf initial format overflow");
    }
    off = (size_t)n0;
    remaining -= (size_t)n0;
  }
  for (size_t i = 1; i < depth; i++) {
    char term_record[32];
    char app_record[32];
    uint32_t left = (uint32_t)(2 * i * 20);
    uint32_t right = (uint32_t)((2 * i + 1) * 20);
    char glyph = (i % 3 == 1) ? 'I' : (i % 3 == 2) ? 'S' : 'K';
    topo_terminal_record(glyph, term_record, sizeof(term_record));
    topo_app_record(left, right, app_record, sizeof(app_record));
    int n = snprintf(spine_buf + off, remaining, "|%s|%s", term_record,
                     app_record);
    if (n < 0 || (size_t)n >= remaining) {
      return fail("deep left spine: snprintf overflow while building spine");
    }
    off += (size_t)n;
    remaining -= (size_t)n;
  }

  size_t end_idx = 0;
  uint32_t root = parse_dag(spine_buf, off, &end_idx);
  if (root == EMPTY)
    return fail("deep left spine: parse_dag failed");

  static char out_buf[128 * 1024];
  size_t n = unparse_dag(root, out_buf, sizeof(out_buf));
  if (n == 0)
    return fail("deep left spine: unparse_dag returned 0");
  if (n == (size_t)-1)
    return fail("deep left spine: unparse_dag overflow");
  /* Re-parse to ensure export was valid */
  size_t end2 = 0;
  uint32_t root2 = parse_dag(out_buf, n, &end2);
  if (root2 == EMPTY)
    return fail("deep left spine: re-parse of exported DAG failed");
  return ok("deep left spine export (iterative)");
}

int main(void) {
  if (!initArena(1u << 20)) {
    fprintf(stderr, "FAIL: initArena\n");
    return 1;
  }

  int r = 0;
  r |= test_roundtrip_sharing();
  r |= test_malformed_refs();
  r |= test_deep_left_spine();

  fflush(stdout);
  fflush(stderr);
  return r ? 1 : 0;
}
