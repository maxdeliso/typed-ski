#include "thanatos.h"
#include <dirent.h>
#include <errno.h>
#include <pthread.h>
#include <signal.h>
#include <stdatomic.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

enum {
  TRACE_TEST_SOURCE_BRANCHY = 1000,
  TRACE_TEST_PROC_BRANCHY_EXPENSIVE = 1001,
  TRACE_TEST_PROC_BRANCHY_CHEAP = 1002,
};

typedef struct {
  uint32_t node_id;
  uint32_t max_steps;
  TraceExecProvenance provenance;
  atomic_bool done;
  uint32_t result;
} ReduceThreadCtx;

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
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return (long long)ts.tv_sec * 1000000000LL + ts.tv_nsec;
}

static void *reduce_thread_main(void *arg) {
  ReduceThreadCtx *ctx = (ReduceThreadCtx *)arg;
  ctx->result = thanatos_reduce_with_provenance(
      ctx->node_id, ctx->max_steps, ctx->provenance);
  atomic_store_explicit(&ctx->done, true, memory_order_release);
  return NULL;
}

static uint32_t build_identity_chain(uint32_t depth) {
  uint32_t expr = allocTerminal(ARENA_SYM_K);
  uint32_t i = allocTerminal(ARENA_SYM_I);
  for (uint32_t n = 0; n < depth; n++) {
    expr = allocCons(i, expr);
  }
  return expr;
}

static bool wait_for_trace_dump_path(const char *trace_dir, char *path_out,
                                     size_t path_out_cap,
                                     uint32_t expected_epoch,
                                     uint32_t timeout_ms) {
  if (trace_dir == NULL || path_out == NULL || path_out_cap == 0)
    return false;
  int n = snprintf(path_out, path_out_cap,
                   "%s/thanatos-trace-pid%d-epoch%u.json", trace_dir,
                   (int)getpid(), expected_epoch);
  if (n < 0 || (size_t)n >= path_out_cap)
    return false;
  for (uint32_t waited = 0; waited < timeout_ms; waited++) {
    if (access(path_out, F_OK) == 0)
      return true;
    usleep(1000);
  }
  return false;
}

static char *read_text_file(const char *path) {
  FILE *f = fopen(path, "rb");
  if (f == NULL)
    return NULL;
  if (fseek(f, 0, SEEK_END) != 0) {
    fclose(f);
    return NULL;
  }
  long len = ftell(f);
  if (len < 0) {
    fclose(f);
    return NULL;
  }
  if (fseek(f, 0, SEEK_SET) != 0) {
    fclose(f);
    return NULL;
  }
  char *buf = malloc((size_t)len + 1);
  if (buf == NULL) {
    fclose(f);
    return NULL;
  }
  if (len > 0 && fread(buf, 1, (size_t)len, f) != (size_t)len) {
    free(buf);
    fclose(f);
    return NULL;
  }
  buf[len] = '\0';
  fclose(f);
  return buf;
}

static void remove_trace_dir_files(const char *trace_dir) {
  DIR *dir = opendir(trace_dir);
  if (dir == NULL)
    return;
  struct dirent *entry;
  while ((entry = readdir(dir)) != NULL) {
    if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0)
      continue;
    char path[512];
    int n = snprintf(path, sizeof(path), "%s/%s", trace_dir, entry->d_name);
    if (n >= 0 && (size_t)n < sizeof(path))
      unlink(path);
  }
  closedir(dir);
  rmdir(trace_dir);
}

static int count_occurrences(const char *haystack, const char *needle) {
  int count = 0;
  size_t needle_len = strlen(needle);
  if (needle_len == 0)
    return 0;
  const char *cursor = haystack;
  while ((cursor = strstr(cursor, needle)) != NULL) {
    count++;
    cursor += needle_len;
  }
  return count;
}

static int run_trace_provenance_self_test(uint32_t arena_capacity) {
  char trace_dir[] = "/tmp/thanatos-prov-XXXXXX";
  if (mkdtemp(trace_dir) == NULL) {
    fprintf(stderr, "trace provenance self-test: mkdtemp failed (errno=%d)\n",
            errno);
    return 1;
  }

  ThanatosConfig config = {
      .num_workers = 2,
      .arena_capacity = arena_capacity,
      .stdin_fd = -1,
      .trace_dir = trace_dir,
      .trace_timeout_ms = 1000,
  };
  thanatos_init(config);
  thanatos_start_threads(true);

  if (!arena_trace_register_source(TRACE_TEST_SOURCE_BRANCHY,
                                   "test/provenance/Branchy.trip", 1, 1, 20,
                                   1) ||
      !arena_trace_register_proc(TRACE_TEST_PROC_BRANCHY_EXPENSIVE,
                                 "Branchy.expensive", TRACE_PHASE_LOWER,
                                 TRACE_TEST_SOURCE_BRANCHY, 1) ||
      !arena_trace_register_proc(TRACE_TEST_PROC_BRANCHY_CHEAP,
                                 "Branchy.cheap", TRACE_PHASE_LOWER,
                                 TRACE_TEST_SOURCE_BRANCHY, 1)) {
    fprintf(stderr,
            "trace provenance self-test: failed to register source/proc symbols\n");
    remove_trace_dir_files(trace_dir);
    return 1;
  }

  const uint32_t expensive_depth =
      (arena_capacity > 32768u) ? (arena_capacity / 2u) : 16384u;
  ReduceThreadCtx expensive = {
      .node_id = build_identity_chain(expensive_depth),
      .max_steps = 0xffffffffu,
      .provenance = {
          .phase_id = TRACE_PHASE_LOWER,
          .proc_id = TRACE_TEST_PROC_BRANCHY_EXPENSIVE,
          .source_id = TRACE_TEST_SOURCE_BRANCHY,
          .block_id = 1,
      },
      .done = false,
      .result = EMPTY,
  };
  ReduceThreadCtx cheap = {
      .node_id =
          allocCons(allocTerminal(ARENA_SYM_I), allocTerminal(ARENA_SYM_K)),
      .max_steps = 0xffffffffu,
      .provenance = {
          .phase_id = TRACE_PHASE_LOWER,
          .proc_id = TRACE_TEST_PROC_BRANCHY_CHEAP,
          .source_id = TRACE_TEST_SOURCE_BRANCHY,
          .block_id = 2,
      },
      .done = false,
      .result = EMPTY,
  };

  pthread_t expensive_thread;
  pthread_t cheap_thread;
  if (pthread_create(&expensive_thread, NULL, reduce_thread_main, &expensive) !=
      0) {
    fprintf(stderr,
            "trace provenance self-test: failed to start expensive thread\n");
    remove_trace_dir_files(trace_dir);
    return 1;
  }

  unsigned long long steps_before = arena_total_steps();
  const unsigned long long target_delta = 512;
  const long long deadline_ns = get_time_ns() + 2000000000LL;
  while (!atomic_load_explicit(&expensive.done, memory_order_acquire) &&
         arena_total_steps() < steps_before + target_delta &&
         get_time_ns() < deadline_ns) {
    usleep(1000);
  }
  if (atomic_load_explicit(&expensive.done, memory_order_acquire)) {
    fprintf(stderr,
            "trace provenance self-test: expensive path completed before trace capture\n");
    pthread_join(expensive_thread, NULL);
    remove_trace_dir_files(trace_dir);
    return 1;
  }

  if (pthread_create(&cheap_thread, NULL, reduce_thread_main, &cheap) != 0) {
    fprintf(stderr, "trace provenance self-test: failed to start cheap thread\n");
    pthread_join(expensive_thread, NULL);
    remove_trace_dir_files(trace_dir);
    return 1;
  }
  pthread_join(cheap_thread, NULL);

  if (raise(SIGHUP) != 0) {
    fprintf(stderr, "trace provenance self-test: raise(SIGHUP) failed\n");
    pthread_join(expensive_thread, NULL);
    remove_trace_dir_files(trace_dir);
    return 1;
  }

  char dump_path[512];
  if (!wait_for_trace_dump_path(trace_dir, dump_path, sizeof(dump_path), 1,
                                2000)) {
    fprintf(stderr,
            "trace provenance self-test: timed out waiting for trace dump\n");
    pthread_join(expensive_thread, NULL);
    remove_trace_dir_files(trace_dir);
    return 1;
  }

  char *dump_json = read_text_file(dump_path);
  if (dump_json == NULL) {
    fprintf(stderr,
            "trace provenance self-test: failed to read trace dump %s\n",
            dump_path);
    pthread_join(expensive_thread, NULL);
    remove_trace_dir_files(trace_dir);
    return 1;
  }

  const char *expensive_worker_pattern =
      "\"phase_id\":6,\"proc_id\":1001,\"source_id\":1000,\"block_id\":1,\"focus\"";
  const char *cheap_event_pattern =
      "\"kind\":\"job_start\",\"phase_id\":6,\"proc_id\":1002,\"source_id\":1000,\"block_id\":2";
  bool has_expensive_symbol =
      strstr(dump_json, "\"name\":\"Branchy.expensive\"") != NULL;
  bool has_cheap_symbol = strstr(dump_json, "\"name\":\"Branchy.cheap\"") !=
                          NULL;
  bool has_source_symbol =
      strstr(dump_json, "\"file\":\"test/provenance/Branchy.trip\"") != NULL;
  bool has_expensive_worker = strstr(dump_json, expensive_worker_pattern) !=
                              NULL;
  bool has_cheap_event = strstr(dump_json, cheap_event_pattern) != NULL;

  printf("trace provenance self-test: dump=%s expensive-proc-occurrences=%d "
         "cheap-proc-occurrences=%d\n",
         dump_path, count_occurrences(dump_json, "\"proc_id\":1001"),
         count_occurrences(dump_json, "\"proc_id\":1002"));

  free(dump_json);

  pthread_join(expensive_thread, NULL);
  remove_trace_dir_files(trace_dir);

  if (!has_expensive_symbol || !has_cheap_symbol || !has_source_symbol ||
      !has_expensive_worker || !has_cheap_event) {
    fprintf(stderr,
            "trace provenance self-test: missing expected provenance evidence "
            "(expensive_symbol=%d cheap_symbol=%d source_symbol=%d "
            "expensive_worker=%d cheap_event=%d)\n",
            has_expensive_symbol, has_cheap_symbol, has_source_symbol,
            has_expensive_worker, has_cheap_event);
    return 1;
  }

  return 0;
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

  if (run_trace_provenance_self_test(arena_capacity) != 0)
    return 1;
  reset();
  thanatos_reset_stats();

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
