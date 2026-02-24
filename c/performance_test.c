#include "thanatos.h"
#include <stdio.h>
#include <stdlib.h>
#include <time.h>

static uint32_t rand_expression(int depth) {
  if (depth <= 0 || (rand() % 10) == 0) {
    int r = rand() % 3;
    if (r == 0)
      return allocTerminal(ARENA_SYM_S);
    if (r == 1)
      return allocTerminal(ARENA_SYM_K);
    return allocTerminal(ARENA_SYM_I);
  }
  return allocCons(rand_expression(depth - 1), rand_expression(depth - 1));
}

static long long get_time_ns(void) {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return (long long)ts.tv_sec * 1000000000LL + ts.tv_nsec;
}

int main(int argc, char **argv) {
  int num_threads = 8;
  uint32_t arena_capacity = 1u << 26;
  int reductions = 2048;
  int depth = 5;
  uint32_t max_steps = 0xffffffffu;
  unsigned int seed = 0; /* 0 means use time(NULL) */

  if (argc > 1)
    num_threads = atoi(argv[1]);
  if (argc > 2) {
    arena_capacity = (uint32_t)strtoul(argv[2], NULL, 0);
    if (arena_capacity == 0) {
      fprintf(stderr, "Invalid arena capacity: %s\n", argv[2]);
      return 1;
    }
  }
  if (argc > 3) {
    reductions = atoi(argv[3]);
    if (reductions <= 0) {
      fprintf(stderr, "Invalid reductions count: %s\n", argv[3]);
      return 1;
    }
  }
  if (argc > 4) {
    depth = atoi(argv[4]);
    if (depth < 0) {
      fprintf(stderr, "Invalid expression depth: %s\n", argv[4]);
      return 1;
    }
  }
  if (argc > 5) {
    max_steps = (uint32_t)strtoul(argv[5], NULL, 0);
  }
  if (argc > 6) {
    seed = (unsigned int)strtoul(argv[6], NULL, 0);
  }

  if (seed == 0)
    seed = (unsigned int)time(NULL);
  srand(seed);

  printf("Starting Thanatos Performance Test with %d threads (arena=%u, N=%d, "
         "depth=%d, max_steps=%u, seed=%u)...\n",
         num_threads, arena_capacity, reductions, depth, max_steps, seed);

  ThanatosConfig config = {.num_workers = num_threads,
                           .arena_capacity = arena_capacity};
  thanatos_init(config);
  thanatos_start_threads();

  /* Smoke test: EQ_U8 5 5 -> True (K), EQ_U8 5 6 -> False (K I) */
  {
    uint32_t eq = allocTerminal(ARENA_SYM_EQ_U8);
    uint32_t u8_5 = allocU8(5);
    uint32_t u8_6 = allocU8(6);
    uint32_t expr_eq_5_5 = allocCons(allocCons(eq, u8_5), u8_5);
    uint32_t expr_eq_5_6 = allocCons(allocCons(eq, u8_5), u8_6);
    uint32_t r1 = thanatos_reduce(expr_eq_5_5, 10000u);
    uint32_t r2 = thanatos_reduce(expr_eq_5_6, 10000u);
    int ok1 = (kindOf(r1) == ARENA_KIND_TERMINAL && symOf(r1) == ARENA_SYM_K);
    uint32_t k = allocTerminal(ARENA_SYM_K);
    uint32_t i = allocTerminal(ARENA_SYM_I);
    uint32_t false_form = allocCons(k, i);
    int ok2 = (r2 == false_form) || (kindOf(r2) == ARENA_KIND_NON_TERM &&
                                     leftOf(r2) == k && rightOf(r2) == i);
    if (!ok1 || !ok2) {
      fprintf(stderr, "EQ_U8 smoke test failed: eq 5 5 -> %s, eq 5 6 -> %s\n",
              ok1 ? "OK" : "FAIL", ok2 ? "OK" : "FAIL");
      return 1;
    }
  }

  printf("Pre-generating %d random expressions...\n", reductions);
  uint32_t *exprs = malloc(sizeof(uint32_t) * (size_t)reductions);
  if (exprs == NULL) {
    fprintf(stderr, "Failed to allocate expression array\n");
    return 1;
  }
  for (int i = 0; i < reductions; i++) {
    if ((i % 100) == 0)
      printf("Generating %d/%d...\n", i, reductions);
    exprs[i] = rand_expression(depth);
  }

  printf("Measuring reduction performance...\n");
  long long start = get_time_ns();

  for (int i = 0; i < reductions; i++) {
    if ((i % 100) == 0)
      printf("Reducing %d/%d...\n", i, reductions);
    thanatos_reduce(exprs[i], max_steps);
  }

  long long end = get_time_ns();
  long long elapsed = end - start;
  double avg = (double)elapsed / reductions;

  printf("Completed %d reductions in %.3f ms\n", reductions,
         elapsed / 1000000.0);
  printf("Average reduction time: %.3f ns\n", avg);

  thanatos_shutdown();
  free(exprs);
  return 0;
}
