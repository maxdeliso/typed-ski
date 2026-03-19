#include "ski_io.h"
#include "arena.h"
#include "thanatos.h"
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static uint32_t parse_surface(const char *surface) {
  size_t end = 0;
  uint32_t root = parse_ski(surface, strlen(surface), &end);
  assert(root != EMPTY);
  assert(end == strlen(surface));
  return root;
}

typedef struct {
  char glyph;
  char lowercase;
  uint32_t sym;
} TerminalCase;

static const TerminalCase TERMINAL_CASES[] = {
    {'S', 's', ARENA_SYM_S},
    {'K', 'k', ARENA_SYM_K},
    {'I', 'i', ARENA_SYM_I},
    {'B', 'b', ARENA_SYM_B},
    {'C', 'c', ARENA_SYM_C},
    {'P', 'p', ARENA_SYM_SPRIME},
    {'Q', 'q', ARENA_SYM_BPRIME},
    {'R', 'r', ARENA_SYM_CPRIME},
    {',', 0, ARENA_SYM_READ_ONE},
    {'.', 0, ARENA_SYM_WRITE_ONE},
    {'E', 'e', ARENA_SYM_EQ_U8},
    {'L', 'l', ARENA_SYM_LT_U8},
    {'D', 'd', ARENA_SYM_DIV_U8},
    {'M', 'm', ARENA_SYM_MOD_U8},
    {'A', 'a', ARENA_SYM_ADD_U8},
    {'O', 'o', ARENA_SYM_SUB_U8},
};

static void test_parse_ski_round_trip(void) {
  printf("test_parse_ski_round_trip...\n");
  reset();

  uint32_t root = parse_surface("(s #u8(7))");
  char buf[64];
  size_t n = unparse_ski(root, buf, sizeof(buf));
  assert(n > 0);
  assert(strcmp(buf, "(S #u8(7))") == 0);
}

static void test_parse_ski_invalid_inputs(void) {
  printf("test_parse_ski_invalid_inputs...\n");
  reset();
  size_t end = 0;

  assert(parse_ski("", 0, &end) == EMPTY);
  assert(parse_ski("X", 1, &end) == EMPTY);
  assert(parse_ski("(S K", 4, &end) == EMPTY);
  assert(parse_ski("#u8(999)", 8, &end) == EMPTY);
}

static void test_parse_ski_all_terminals(void) {
  printf("test_parse_ski_all_terminals...\n");
  reset();
  for (size_t i = 0; i < sizeof(TERMINAL_CASES) / sizeof(TERMINAL_CASES[0]); i++) {
    char text[2] = {TERMINAL_CASES[i].glyph, '\0'};
    size_t end = 0;
    uint32_t root = parse_ski(text, 1, &end);
    assert(root != EMPTY);
    assert(end == 1);
    assert(kindOf(root) == ARENA_KIND_TERMINAL);
    assert(symOf(root) == TERMINAL_CASES[i].sym);

    if (TERMINAL_CASES[i].lowercase != 0) {
      text[0] = TERMINAL_CASES[i].lowercase;
      root = parse_ski(text, 1, &end);
      assert(root != EMPTY);
      assert(end == 1);
      assert(kindOf(root) == ARENA_KIND_TERMINAL);
      assert(symOf(root) == TERMINAL_CASES[i].sym);
    }
  }
}

static void test_parse_u8_edge_cases(void) {
  printf("test_parse_u8_edge_cases...\n");
  reset();
  size_t end = 0;

  assert(parse_ski("#u8(256)", 8, &end) == EMPTY);
  assert(parse_ski("#u8(12", 6, &end) == EMPTY);
  assert(parse_ski("#u8()", 5, &end) == EMPTY);

  uint32_t root = parse_ski("#u8(255)", 8, &end);
  assert(root != EMPTY);
  assert(kindOf(root) == ARENA_KIND_U8);
  assert(symOf(root) == 255);
}

static void test_unparse_ski_edge_cases(void) {
  printf("test_unparse_ski_edge_cases...\n");
  reset();

  char buf[8];
  assert(unparse_ski(EMPTY, buf, sizeof(buf)) == 0);
  assert(strcmp(buf, "") == 0);
  assert(unparse_ski(allocTerminal(ARENA_SYM_I), NULL, 0) == 0);

  uint32_t root = allocCons(allocTerminal(ARENA_SYM_S), allocTerminal(ARENA_SYM_K));
  size_t n = unparse_ski(root, buf, 4);
  assert(n <= sizeof(buf));
}

static void test_unparse_ski_all_terminals(void) {
  printf("test_unparse_ski_all_terminals...\n");
  reset();
  char buf[16];
  for (size_t i = 0; i < sizeof(TERMINAL_CASES) / sizeof(TERMINAL_CASES[0]); i++) {
    uint32_t node = allocTerminal(TERMINAL_CASES[i].sym);
    size_t n = unparse_ski(node, buf, sizeof(buf));
    assert(n == 1);
    assert(buf[0] == TERMINAL_CASES[i].glyph);
    assert(buf[1] == '\0');
  }
}

static void test_parse_dag_edge_cases(void) {
  printf("test_parse_dag_edge_cases...\n");
  reset();
  size_t end = 0;

  assert(parse_dag("@1,0 S", 6, &end) == EMPTY);
  assert(parse_dag("S K GIBBERISH", 13, &end) == EMPTY);
  assert(parse_dag("  ", 2, &end) == EMPTY);
  assert(parse_dag("@X,Y", 4, &end) == EMPTY);
  assert(parse_dag("UXX", 3, &end) == EMPTY);
}

static void test_parse_dag_success_with_whitespace(void) {
  printf("test_parse_dag_success_with_whitespace...\n");
  reset();
  const char *dag = "\tU2a \n I @0,1";
  size_t end = 0;
  uint32_t root = parse_dag(dag, strlen(dag), &end);
  assert(root != EMPTY);
  assert(end == strlen(dag));

  char buf[64];
  size_t n = unparse_dag(root, buf, sizeof(buf));
  assert(n > 0);
  assert(strcmp(buf, "U2a I @0,1") == 0);
}

static void test_parse_dag_all_terminals(void) {
  printf("test_parse_dag_all_terminals...\n");
  reset();
  for (size_t i = 0; i < sizeof(TERMINAL_CASES) / sizeof(TERMINAL_CASES[0]); i++) {
    char text[2] = {TERMINAL_CASES[i].glyph, '\0'};
    size_t end = 0;
    uint32_t root = parse_dag(text, 1, &end);
    assert(root != EMPTY);
    assert(end == 1);
    assert(kindOf(root) == ARENA_KIND_TERMINAL);
    assert(symOf(root) == TERMINAL_CASES[i].sym);
  }

  size_t end = 0;
  uint32_t app = parse_dag("S K @ 0 , 1", strlen("S K @ 0 , 1"), &end);
  assert(app != EMPTY);
  assert(end == strlen("S K @ 0 , 1"));
}

static void test_unparse_dag_small_buffer(void) {
  printf("test_unparse_dag_small_buffer...\n");
  reset();
  uint32_t root = parse_surface("I");
  char buf[1];
  assert(unparse_dag(root, buf, sizeof(buf)) == (size_t)-1);
}

static void test_unparse_empty_dag(void) {
  printf("test_unparse_empty_dag...\n");
  reset();
  char buf[32];
  assert(unparse_dag(EMPTY, buf, sizeof(buf)) == 0);
}

static void test_dag_unparse_rehash(void) {
  printf("test_dag_unparse_rehash...\n");
  reset();

  uint32_t root = allocTerminal(ARENA_SYM_I);
  for (int i = 0; i < 300; i++) {
    root = allocCons(root, allocTerminal(ARENA_SYM_I));
  }

  char *buf = malloc(1024 * 1024);
  assert(buf != NULL);
  size_t n = unparse_dag(root, buf, 1024 * 1024);
  assert(n > 0);
  assert(n != (size_t)-1);
  free(buf);
}

int main(void) {
  ThanatosConfig config = {
      .num_workers = 1,
      .arena_capacity = 65536,
      .stdin_fd = -1,
  };
  thanatos_init(config);
  thanatos_start_threads(true);

  test_parse_ski_round_trip();
  test_parse_ski_invalid_inputs();
  test_parse_ski_all_terminals();
  test_parse_u8_edge_cases();
  test_unparse_ski_edge_cases();
  test_unparse_ski_all_terminals();
  test_parse_dag_edge_cases();
  test_parse_dag_success_with_whitespace();
  test_parse_dag_all_terminals();
  test_unparse_dag_small_buffer();
  test_unparse_empty_dag();
  test_dag_unparse_rehash();

  thanatos_shutdown();
  printf("ski_io_test passed!\n");
  return 0;
}
