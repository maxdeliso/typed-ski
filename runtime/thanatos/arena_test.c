#include "arena.h"
#include "ski_io.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>

static uint32_t parse_surface(const char *surface) {
  size_t end = 0;
  uint32_t root = parse_ski(surface, strlen(surface), &end);
  assert(root != EMPTY);
  assert(end == strlen(surface));
  return root;
}

static void assert_surface_eq(uint32_t root, const char *expected) {
  uint32_t expected_root = parse_surface(expected);
  assert(root == expected_root);
}

static void test_repeated_kernel_step_chases_links(void) {
  printf("test_repeated_kernel_step_chases_links...\n");
  reset();

  uint32_t root = parse_surface("III");
  uint32_t first = arenaKernelStep(root);
  uint32_t second = arenaKernelStep(root);
  uint32_t third = arenaKernelStep(root);

  assert_surface_eq(first, "II");
  assert_surface_eq(second, "I");
  assert_surface_eq(third, "I");
}

int main(void) {
  assert(initArena(1u << 20) != 0);
  test_repeated_kernel_step_chases_links();
  printf("arena_test passed!\n");
  return 0;
}
