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

/* 1. Export/import round-trip of a DAG with sharing.
 *    DAG "S K I @0,1 @0,2": node 0 (S) is shared as left child of both apps. */
static int test_roundtrip_sharing(void) {
  const char *dag = "S K I @0,1 @0,2";
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

/* 2. Malformed @L,R: forward refs and out-of-range indices. */
static int test_malformed_refs(void) {
  const char *bad[] = {
      "@0,0",   /* app before any terminals: L=0,R=0 but token index 0 is this
                   app, so L < 0 is false; L=0,R=0 with i=0 means L>=i (0>=0) so
                   invalid */
      "S @1,0", /* @1,0 at index 1: L=1,R=0, need L<1 and R<1, so L<=0,R<=0. L=1
                   fails. */
      "S K @2,0",        /* @2,0 at index 2: L=2,R=0; L<2? 2<2 false. */
      "S K I @0,1 @3,4", /* last token @3,4: indices 3 and 4; we have 0,1,2,3 so
                            index 4 is out of range (4 < 4 false). */
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
  return ok("malformed @L,R and forward refs");
}

/* 3. Deep left spine: build DAG with many left-associative apps, export
 * iteratively. */
static int test_deep_left_spine(void) {
  /* Postorder for (((S K) I) S) K: 0=S, 1=K, 2=@0,1, 3=I, 4=@2,3, 5=S, 6=@4,5,
   * 7=K, 8=@6,7. So after "S K @0,1" we have indices 0,1,2. For step i we add
   * term at 2*i+1 and app @2*i,2*i+1 at 2*i+2. */
  static char spine_buf[64 * 1024];
  const size_t depth = 200;
  size_t off = 0;
  size_t remaining = sizeof(spine_buf);
  {
    int n0 = snprintf(spine_buf, remaining, "S K @0,1");
    if (n0 < 0 || (size_t)n0 >= remaining) {
      return fail("deep left spine: snprintf initial format overflow");
    }
    off = (size_t)n0;
    remaining -= (size_t)n0;
  }
  for (size_t i = 1; i < depth; i++) {
    uint32_t l = (uint32_t)(2 * i);
    uint32_t r = (uint32_t)(2 * i + 1);
    const char *term = (i % 3 == 1) ? " I " : (i % 3 == 2) ? " S " : " K ";
    int n = snprintf(spine_buf + off, remaining, "%s@%u,%u", term,
                     (unsigned)l, (unsigned)r);
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
  if (initArena(1u << 20) == 0) {
    fprintf(stderr, "FAIL: initArena\n");
    return 1;
  }

  int r = 0;
  r |= test_roundtrip_sharing();
  r |= test_malformed_refs();
  r |= test_deep_left_spine();

  return r ? 1 : 0;
}
