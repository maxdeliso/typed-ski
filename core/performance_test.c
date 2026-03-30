#include "host_platform.h"
#include "thanatos.h"
#include <stdio.h>
#include <stdlib.h>
#include <time.h>

static int parse_u32_arg(const char *text, uint32_t *out) {
  uint64_t value = 0;
  if (text == NULL || out == NULL || *text == '\0')
    return 0;
  for (const unsigned char *p = (const unsigned char *)text; *p != '\0'; p++) {
    if (*p < '0' || *p > '9')
      return 0;
    value = value * 10u + (uint64_t)(*p - '0');
    if (value > 0xffffffffu)
      return 0;
  }
  *out = (uint32_t)value;
  return 1;
}

static int parse_int_arg(const char *text, int *out) {
  uint32_t value = 0;
  if (!parse_u32_arg(text, &value) || value > 0x7fffffffu || out == NULL)
    return 0;
  *out = (int)value;
  return 1;
}

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
  return (long long)host_monotonic_time_ns();
}

typedef struct {
  uint32_t top;
  uint32_t capacity;
  unsigned long long total_nodes;
  unsigned long long total_steps;
  unsigned long long total_cons_allocs;
  unsigned long long duplicate_lost_allocs;
  unsigned long long hashcons_hits;
  unsigned long long hashcons_misses;
  unsigned long long hash_items;
  unsigned long long hash_used_buckets;
  unsigned long long hash_chain_sq_sum;
  uint32_t hash_max_chain;
} PerfStats;

static PerfStats capture_stats(void) {
  PerfStats stats;
  thanatos_get_stats(&stats.top, &stats.capacity, &stats.total_nodes,
                     &stats.total_steps, &stats.total_cons_allocs, NULL, NULL,
                     &stats.duplicate_lost_allocs, &stats.hashcons_hits,
                     &stats.hashcons_misses, NULL, NULL);
  arena_hash_table_stats(&stats.hash_items, &stats.hash_used_buckets,
                         &stats.hash_chain_sq_sum, &stats.hash_max_chain);
  return stats;
}

static void print_hash_stats(const char *label, const PerfStats *before,
                             const PerfStats *after) {
  unsigned long long hits = after->hashcons_hits - before->hashcons_hits;
  unsigned long long misses = after->hashcons_misses - before->hashcons_misses;
  unsigned long long total = hits + misses;
  unsigned long long duplicate_lost =
      after->duplicate_lost_allocs - before->duplicate_lost_allocs;
  double hit_rate = (total == 0) ? 0.0 : (100.0 * (double)hits / (double)total);
  double used_pct = (after->capacity == 0)
                        ? 0.0
                        : (100.0 * (double)after->hash_used_buckets /
                           (double)after->capacity);
  double avg_hit_probes =
      (after->hash_items == 0)
          ? 0.0
          : ((double)after->hash_chain_sq_sum + (double)after->hash_items) /
                (2.0 * (double)after->hash_items);
  double avg_miss_probes = (after->capacity == 0) ? 0.0
                                                  : (double)after->hash_items /
                                                        (double)after->capacity;

  printf("%s hash: hits=%llu misses=%llu hit-rate=%.2f%% items=%llu "
         "used-buckets=%llu/%u (%.2f%%) avg-hit-probes~=%.3f "
         "avg-miss-probes~=%.3f max-chain=%u duplicate-lost=%llu\n",
         label, hits, misses, hit_rate, after->hash_items,
         after->hash_used_buckets, after->capacity, used_pct, avg_hit_probes,
         avg_miss_probes, after->hash_max_chain, duplicate_lost);
}

int main(int argc, char **argv) {
  int num_threads = 8;
  uint32_t arena_capacity = 1u << 26;
  int reductions = 2048;
  int depth = 5;
  uint32_t max_steps = 0xffffffffu;
  unsigned int seed = 0; /* 0 means use time(NULL) */

  if (argc > 1 && !parse_int_arg(argv[1], &num_threads)) {
    fprintf(stderr, "Invalid thread count: %s\n", argv[1]);
    return 1;
  }
  if (argc > 2) {
    if (!parse_u32_arg(argv[2], &arena_capacity) || arena_capacity == 0) {
      fprintf(stderr, "Invalid arena capacity: %s\n", argv[2]);
      return 1;
    }
  }
  if (argc > 3) {
    if (!parse_int_arg(argv[3], &reductions) || reductions <= 0) {
      fprintf(stderr, "Invalid reductions count: %s\n", argv[3]);
      return 1;
    }
  }
  if (argc > 4) {
    if (!parse_int_arg(argv[4], &depth)) {
      fprintf(stderr, "Invalid expression depth: %s\n", argv[4]);
      return 1;
    }
  }
  if (argc > 5 && !parse_u32_arg(argv[5], &max_steps)) {
    fprintf(stderr, "Invalid max_steps: %s\n", argv[5]);
    return 1;
  }
  if (argc > 6 && !parse_u32_arg(argv[6], &seed)) {
    fprintf(stderr, "Invalid seed: %s\n", argv[6]);
    return 1;
  }

  if (seed == 0)
    seed = (unsigned int)time(NULL);
  srand(seed);

  printf("Starting Thanatos Performance Test with %d threads (arena=%u, N=%d, "
         "depth=%d, max_steps=%u, seed=%u)...\n",
         num_threads, arena_capacity, reductions, depth, max_steps, seed);
  printf("Hash mixer: %s\n", arena_hash_mix_name());
  printf("Hash buckets: %s\n", arena_hash_bucket_name());

  ThanatosConfig config = {.num_workers = num_threads,
                           .arena_capacity = arena_capacity};
  thanatos_init(config);
  thanatos_start_threads(true);

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

  PerfStats before_generation = capture_stats();
  long long gen_start = get_time_ns();
  for (int i = 0; i < reductions; i++) {
    if ((i % 100) == 0)
      printf("Generating %d/%d...\n", i, reductions);
    exprs[i] = rand_expression(depth);
  }
  long long gen_end = get_time_ns();
  PerfStats after_generation = capture_stats();

  printf("Completed generation in %.3f ms\n",
         (gen_end - gen_start) / 1000000.0);
  print_hash_stats("Generation", &before_generation, &after_generation);

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
  PerfStats after_reduction = capture_stats();

  printf("Completed %d reductions in %.3f ms\n", reductions,
         elapsed / 1000000.0);
  printf("Average reduction time: %.3f ns\n", avg);
  print_hash_stats("Reduction", &after_generation, &after_reduction);

  thanatos_shutdown();
  free(exprs);
  return 0;
}
