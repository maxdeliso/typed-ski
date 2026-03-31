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
  unsigned long long total_cont_allocs;
  unsigned long long total_susp_allocs;
  unsigned long long duplicate_lost_allocs;
  unsigned long long hashcons_hits;
  unsigned long long hashcons_misses;
  unsigned long long dispatcher_events;
  unsigned long long dispatcher_dropped;
  uint32_t pending_active;
  uint32_t pending_done;
  uint32_t sq_occupancy;
  uint32_t cq_occupancy;
  unsigned long long hash_items;
  unsigned long long hash_used_buckets;
  unsigned long long hash_chain_sq_sum;
  uint32_t hash_max_chain;
} PerfStats;

typedef struct {
  uint32_t *exprs;
  uint32_t *results;
  int reductions;
  uint32_t max_steps;
  atomic_int next_index;
  atomic_int completed;
} PerfReduceContext;

static PerfStats capture_stats(void) {
  PerfStats stats;
  thanatos_get_stats(&stats.top, &stats.capacity, &stats.total_nodes,
                     &stats.total_steps, &stats.total_cons_allocs,
                     &stats.total_cont_allocs, &stats.total_susp_allocs,
                     &stats.duplicate_lost_allocs, &stats.hashcons_hits,
                     &stats.hashcons_misses, &stats.dispatcher_events,
                     &stats.dispatcher_dropped);
  thanatos_debug_pending_requests(&stats.pending_active, &stats.pending_done);
  arena_debug_ring_occupancy(&stats.sq_occupancy, &stats.cq_occupancy);
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

static void print_reduction_stats(const PerfStats *before,
                                  const PerfStats *after,
                                  int reductions,
                                  int changed_results,
                                  int exhausted_step_budget) {
  unsigned long long total_steps = after->total_steps - before->total_steps;
  unsigned long long total_nodes = after->total_nodes - before->total_nodes;
  unsigned long long total_cons_allocs =
      after->total_cons_allocs - before->total_cons_allocs;
  unsigned long long total_cont_allocs =
      after->total_cont_allocs - before->total_cont_allocs;
  unsigned long long total_susp_allocs =
      after->total_susp_allocs - before->total_susp_allocs;
  unsigned long long total_events =
      after->dispatcher_events - before->dispatcher_events;
  unsigned long long total_dropped =
      after->dispatcher_dropped - before->dispatcher_dropped;
  double avg_steps = (reductions <= 0) ? 0.0
                                       : (double)total_steps / (double)reductions;
  double changed_pct = (reductions <= 0)
                           ? 0.0
                           : (100.0 * (double)changed_results /
                              (double)reductions);

  printf("Reduction runtime: steps=%llu avg-steps=%.3f changed=%d/%d (%.2f%%) "
         "step-budget-exhausted=%d new-nodes=%llu cons-allocs=%llu "
         "cont-allocs=%llu susp-allocs=%llu dispatcher-events=%llu "
         "dispatcher-dropped=%llu\n",
         total_steps, avg_steps, changed_results, reductions, changed_pct,
         exhausted_step_budget, total_nodes, total_cons_allocs,
         total_cont_allocs, total_susp_allocs, total_events, total_dropped);
}

static void *reduce_worker_main(void *arg) {
  PerfReduceContext *ctx = (PerfReduceContext *)arg;
  while (true) {
    int index = atomic_fetch_add_explicit(&ctx->next_index, 1,
                                          memory_order_relaxed);
    if (index >= ctx->reductions)
      break;
    ctx->results[index] = thanatos_reduce(ctx->exprs[index], ctx->max_steps);
    atomic_fetch_add_explicit(&ctx->completed, 1, memory_order_release);
  }
  return NULL;
}

int main(int argc, char **argv) {
  int num_threads = 8;
  uint32_t arena_max_capacity = 1u << 26;
  int reductions = 2048;
  int depth = 5;
  uint32_t max_steps = 0xffffffffu;
  unsigned int seed = 0; /* 0 means use time(NULL) */
  const char *trace_dir = getenv("THANATOS_TRACE_DIR");
  int stall_trace_requested = 0;

  if (argc > 1 && !parse_int_arg(argv[1], &num_threads)) {
    fprintf(stderr, "Invalid thread count: %s\n", argv[1]);
    return 1;
  }
  if (argc > 2) {
    if (!parse_u32_arg(argv[2], &arena_max_capacity) || arena_max_capacity == 0) {
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

  printf("Starting Thanatos Performance Test with %d threads (max_arena=%u, N=%d, "
         "depth=%d, max_steps=%u, seed=%u)...\n",
         num_threads, arena_max_capacity, reductions, depth, max_steps, seed);
  printf("Hash mixer: %s\n", arena_hash_mix_name());
  printf("Hash buckets: %s\n", arena_hash_bucket_name());
  fflush(stdout);

  ThanatosConfig config = {.num_workers = num_threads,
                           .arena_capacity = arena_max_capacity,
                           .trace_dir = (trace_dir != NULL && trace_dir[0] != '\0')
                                            ? trace_dir
                                            : NULL,
                           .trace_timeout_ms = 1000};
  thanatos_init(config);
  thanatos_start_threads(true);
  printf("Arena start capacity: %u (max=%u)\n", arena_capacity(),
         arena_max_capacity);
  fflush(stdout);

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
  fflush(stdout);
  uint32_t *exprs = malloc(sizeof(uint32_t) * (size_t)reductions);
  if (exprs == NULL) {
    fprintf(stderr, "Failed to allocate expression array\n");
    return 1;
  }
  uint32_t *results = malloc(sizeof(uint32_t) * (size_t)reductions);
  if (results == NULL) {
    fprintf(stderr, "Failed to allocate result array\n");
    free(exprs);
    return 1;
  }

  PerfStats before_generation = capture_stats();
  long long gen_start = get_time_ns();
  for (int i = 0; i < reductions; i++) {
    if ((i % 100) == 0) {
      printf("Generating %d/%d...\n", i, reductions);
      fflush(stdout);
    }
    exprs[i] = rand_expression(depth);
  }
  long long gen_end = get_time_ns();
  PerfStats after_generation = capture_stats();

  printf("Completed generation in %.3f ms\n",
         (gen_end - gen_start) / 1000000.0);
  print_hash_stats("Generation", &before_generation, &after_generation);
  fflush(stdout);

  int client_threads = num_threads;
  if (client_threads < 1)
    client_threads = 1;
  if (client_threads > reductions)
    client_threads = reductions;

  HostThread *clients =
      malloc(sizeof(HostThread) * (size_t)client_threads);
  if (clients == NULL) {
    fprintf(stderr, "Failed to allocate client thread array\n");
    free(results);
    free(exprs);
    return 1;
  }

  PerfReduceContext reduce_ctx = {
      .exprs = exprs,
      .results = results,
      .reductions = reductions,
      .max_steps = max_steps,
  };
  atomic_init(&reduce_ctx.next_index, 0);
  atomic_init(&reduce_ctx.completed, 0);

  printf("Measuring reduction performance with %d concurrent clients...\n",
         client_threads);
  fflush(stdout);
  long long start = get_time_ns();

  for (int i = 0; i < client_threads; i++) {
    if (host_thread_create(&clients[i], reduce_worker_main, &reduce_ctx) != 0) {
      fprintf(stderr, "Failed to create reduction client thread %d\n", i);
      for (int j = 0; j < i; j++)
        host_thread_join(clients[j]);
      free(clients);
      free(results);
      free(exprs);
      return 1;
    }
  }

  printf("Reducing 0/%d...\n", reductions);
  fflush(stdout);
  int next_report = (reductions >= 100) ? 100 : reductions;
  long long last_progress = start;
  PerfStats last_stats = after_generation;
  int zero_progress_reports = 0;
  while (atomic_load_explicit(&reduce_ctx.completed, memory_order_acquire) <
         reductions) {
    host_sleep_ms(50);
    long long now = get_time_ns();
    int completed =
        atomic_load_explicit(&reduce_ctx.completed, memory_order_acquire);
    if ((now - last_progress) >= 1000000000LL) {
      PerfStats current_stats = capture_stats();
      unsigned long long delta_steps =
          current_stats.total_steps - last_stats.total_steps;
      unsigned long long delta_nodes =
          current_stats.total_nodes - last_stats.total_nodes;
      unsigned long long delta_cons =
          current_stats.total_cons_allocs - last_stats.total_cons_allocs;
      unsigned long long delta_events =
          current_stats.dispatcher_events - last_stats.dispatcher_events;
      unsigned long long delta_conts =
          current_stats.total_cont_allocs - last_stats.total_cont_allocs;
      unsigned long long delta_susps =
          current_stats.total_susp_allocs - last_stats.total_susp_allocs;
      printf("Progress: completed=%d/%d top=%u capacity=%u +steps=%llu "
             "+nodes=%llu +cons=%llu +conts=%llu +susps=%llu +events=%llu "
             "dropped=%llu pending=%u(done=%u) sq=%u cq=%u\n",
             completed, reductions, current_stats.top, current_stats.capacity,
             delta_steps, delta_nodes, delta_cons, delta_conts, delta_susps,
             delta_events, current_stats.dispatcher_dropped,
             current_stats.pending_active, current_stats.pending_done,
             current_stats.sq_occupancy, current_stats.cq_occupancy);
      fflush(stdout);
      if (delta_steps == 0 && delta_nodes == 0 && delta_cons == 0 &&
          delta_events == 0) {
        zero_progress_reports++;
        if (!stall_trace_requested && zero_progress_reports >= 3 &&
            config.trace_dir != NULL) {
          printf("Stall suspected: requesting trace dump in %s\n",
                 config.trace_dir);
          fflush(stdout);
          thanatos_request_trace_dump();
          stall_trace_requested = 1;
        }
      } else {
        zero_progress_reports = 0;
      }
      last_progress = now;
      last_stats = current_stats;
    }
    if (completed >= next_report) {
      printf("Reducing %d/%d...\n", completed, reductions);
      fflush(stdout);
      next_report += 100;
      if (next_report > reductions)
        next_report = reductions;
    }
  }

  for (int i = 0; i < client_threads; i++)
    host_thread_join(clients[i]);
  free(clients);

  long long end = get_time_ns();
  long long elapsed = end - start;
  double avg = (double)elapsed / reductions;
  PerfStats after_reduction = capture_stats();
  int changed_results = 0;
  int exhausted_step_budget = 0;

  for (int i = 0; i < reductions; i++) {
    uint32_t result = results[i];
    if (result != exprs[i])
      changed_results++;
    if (max_steps != 0xffffffffu && is_control_ptr(result) &&
        controlSuspensionReason(result) == SUSP_STEP_LIMIT) {
      exhausted_step_budget++;
    }
  }

  printf("Completed %d reductions in %.3f ms\n", reductions,
         elapsed / 1000000.0);
  printf("Average reduction time: %.3f ns\n", avg);
  print_reduction_stats(&after_generation, &after_reduction, reductions,
                        changed_results, exhausted_step_budget);
  print_hash_stats("Reduction", &after_generation, &after_reduction);
  fflush(stdout);

  thanatos_shutdown();
  free(results);
  free(exprs);
  return 0;
}
