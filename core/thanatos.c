#ifdef _WIN32
#ifndef _CRT_SECURE_NO_WARNINGS
#define _CRT_SECURE_NO_WARNINGS
#endif
#endif

#include "thanatos.h"
#include "host_platform.h"
#include <errno.h>
#include <limits.h>
#ifndef _WIN32
#include <signal.h>
#endif
#include <string.h>
#include <stdatomic.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>

#ifndef PATH_MAX
#define PATH_MAX 4096
#endif

#define MAX_PENDING_REQS 1024
#define MAX_IO_WAIT 1024

typedef struct {
  uint32_t req_id;
  uint32_t result_node;
  uint32_t event_kind;
  bool done;
  HostCond cond;
  HostMutex mutex;
} PendingReq;

typedef struct {
  uint32_t node_id;
  uint32_t req_id;
} IoWaitEntry;

static HostThread *workers = NULL;
static uint32_t num_workers_count = 0;
static atomic_uint next_req_id = 1;
static atomic_bool is_thanatos_initialized = false;
static atomic_ullong dispatcher_events = 0;
static atomic_ullong dispatcher_dropped = 0;
static HostThread dispatcher_thread;
static HostThread stdout_thread;
static HostThread stdin_thread;
static bool stdout_thread_started = false;
static bool stdin_thread_started = false;

static HostMutex io_wait_mutex;
static HostMutex stdout_publish_mutex;
static HostMutex stdin_demand_mutex;
static HostCond stdin_demand_cvar;
static HostMutex pending_req_mutex;
static HostCond pending_req_cvar;
static bool runtime_sync_initialized = false;

/** Optional runtime stdout handler; if NULL, uses putchar(). */
static void (*stdout_handler)(uint8_t, void *) = NULL;
static void *stdout_handler_ctx = NULL;

void thanatos_set_stdout_handler(void (*handler)(uint8_t, void *), void *ctx) {
  host_mutex_lock(&stdout_publish_mutex);
  stdout_handler = handler;
  stdout_handler_ctx = ctx;
  host_mutex_unlock(&stdout_publish_mutex);
}

static PendingReq pending_reqs[MAX_PENDING_REQS];
static IoWaitEntry io_wait_map[MAX_IO_WAIT];
static uint32_t stdin_demand_count = 0;
static bool runtime_stdin_available = false;

/** Pump blocks on this when arena stdout ring is empty; dispatcher signals
 * after each CQE so pump wakes when there may be new stdout (no fixed sleep).
 */
static HostMutex pump_mutex;
static HostCond pump_cvar;
static bool pump_wakeup_pending = false;

static uint32_t io_wait_remove(uint32_t node_id);

static void release_pending_req_slot(int slot) {
  host_mutex_lock(&pending_req_mutex);
  host_mutex_lock(&pending_reqs[slot].mutex);
  pending_reqs[slot].req_id = 0;
  pending_reqs[slot].done = false;
  host_cond_signal(&pending_req_cvar);
  host_mutex_unlock(&pending_reqs[slot].mutex);
  host_mutex_unlock(&pending_req_mutex);
}

static void must_thread_create(HostThread *thread, HostThreadFn entry, void *arg,
                               const char *name) {
  int rc = host_thread_create(thread, entry, arg);
  if (rc != 0) {
    fprintf(stderr, "Thanatos: thread_create(%s) failed (rc=%d)\n", name, rc);
    abort();
  }
}

static bool wake_one_stdin_waiter(void) {
  uint32_t woke_node;
  if (arena_stdin_wait_try_dequeue(&woke_node)) {
    uint32_t woke_req = io_wait_remove(woke_node);
    if (woke_req != 0) {
      while (hostSubmit(woke_node, woke_req, 0) != 0) {
        host_yield();
      }
      return true;
    }
  }
  return false;
}

static bool wake_one_stdout_waiter(void) {
  uint32_t woke_node;
  if (arena_stdout_wait_try_dequeue(&woke_node)) {
    uint32_t woke_req = io_wait_remove(woke_node);
    if (woke_req != 0) {
      while (hostSubmit(woke_node, woke_req, 0) != 0) {
        host_yield();
      }
      return true;
    }
  }
  return false;
}

/* Caller must hold stdout_publish_mutex while reading handler state and
 * invoking it. Session handlers own short-lived contexts; handler swaps must
 * wait until any in-flight publication using the old context is done.
 */
static bool publish_one_stdout_byte_locked(void) {
  uint8_t byte;
  if (!arena_stdout_try_pop(&byte))
    return false;
  void (*handler)(uint8_t, void *) = stdout_handler;
  void *handler_ctx = stdout_handler_ctx;
  if (handler != NULL) {
    handler(byte, handler_ctx);
  } else {
    putchar(byte);
  }
  wake_one_stdout_waiter();
  fflush(stdout);
  return true;
}

static void drain_stdout_locked(void) {
  while (publish_one_stdout_byte_locked()) {
  }
  fflush(stdout);
}

static void *worker_thread_main(void *arg) {
  uint32_t worker_id = (uint32_t)(uintptr_t)arg;
  workerLoop(worker_id);
  return NULL;
}

static bool read_stdin_byte_blocking(uint8_t *byte_out) {
  if (byte_out == NULL)
    return false;
  while (atomic_load_explicit(&is_thanatos_initialized, memory_order_acquire)) {
    int rc = host_runtime_input_read_byte(byte_out);
    if (rc == 1)
      return true;
    if (rc == 0) {
      host_sleep_ms(1);
      continue;
    }
    if (!atomic_load_explicit(&is_thanatos_initialized, memory_order_acquire)) {
      return false;
    }
    fprintf(stderr, "Thanatos: stdin read failed; retrying\n");
    host_sleep_ms(1);
  }
  return false;
}

static void *stdin_thread_main(void *arg) {
  (void)arg;
  while (atomic_load_explicit(&is_thanatos_initialized, memory_order_acquire)) {
    host_mutex_lock(&stdin_demand_mutex);
    while (
        atomic_load_explicit(&is_thanatos_initialized, memory_order_acquire) &&
        stdin_demand_count == 0) {
      host_cond_wait(&stdin_demand_cvar, &stdin_demand_mutex);
    }
    if (!atomic_load_explicit(&is_thanatos_initialized, memory_order_acquire)) {
      host_mutex_unlock(&stdin_demand_mutex);
      break;
    }
    stdin_demand_count--;
    host_mutex_unlock(&stdin_demand_mutex);

    uint8_t byte;
    if (!read_stdin_byte_blocking(&byte))
      break;
    arena_stdin_push(byte);
    wake_one_stdin_waiter();
  }
  return NULL;
}

static bool io_wait_is_stdin(uint32_t node_id) {
  return controlSuspensionReason(node_id) == SUSP_WAIT_IO_STDIN;
}

static void io_wait_register(uint32_t node_id, uint32_t req_id) {
  host_mutex_lock(&io_wait_mutex);
  for (int i = 0; i < MAX_IO_WAIT; i++) {
    if (io_wait_map[i].node_id == EMPTY) {
      io_wait_map[i].node_id = node_id;
      io_wait_map[i].req_id = req_id;
      host_mutex_unlock(&io_wait_mutex);
      return;
    }
  }
  host_mutex_unlock(&io_wait_mutex);
  fprintf(
      stderr,
      "Thanatos: IO wait map full (node_id=%u req_id=%u); aborting to avoid "
      "silent lost wakeups\n",
      node_id, req_id);
  abort();
}

/** Look up req_id by node_id and remove the entry. Returns req_id or 0 if not
 * found. */
static uint32_t io_wait_remove(uint32_t node_id) {
  host_mutex_lock(&io_wait_mutex);
  for (int i = 0; i < MAX_IO_WAIT; i++) {
    if (io_wait_map[i].node_id == node_id) {
      uint32_t req_id = io_wait_map[i].req_id;
      io_wait_map[i].node_id = EMPTY;
      io_wait_map[i].req_id = 0;
      host_mutex_unlock(&io_wait_mutex);
      return req_id;
    }
  }
  host_mutex_unlock(&io_wait_mutex);
  return 0;
}

extern uint8_t *ARENA_BASE_ADDR;

HOST_NO_SANITIZE_ADDRESS static void *
dispatcher_thread_main(void *arg) {
  (void)arg;
  fprintf(stderr, "Dispatcher: started, base=%p\n", (void *)ARENA_BASE_ADDR);
  while (atomic_load_explicit(&is_thanatos_initialized, memory_order_acquire)) {
    if (ARENA_BASE_ADDR) {
      SabHeader *h = (SabHeader *)ARENA_BASE_ADDR;
      if (h->magic != 0x534B4941) {
        fprintf(stderr,
                "Dispatcher: magic mismatch! expected 0x534B4941, got 0x%x\n",
                h->magic);
      }
    }
    Cqe cqe;
    hostCqDequeueBlocking(&cqe);
    /* Shutdown sentinel has req_id == 0 */
    if (cqe.req_id == 0)
      break;

    uint32_t req_id = cqe.req_id;
    uint32_t event = cqe.event_kind & 0x3;
    uint32_t node = cqe.node_id;
    atomic_fetch_add_explicit(&dispatcher_events, 1, memory_order_relaxed);

    bool found = false;
    for (int i = 0; i < MAX_PENDING_REQS; i++) {
      host_mutex_lock(&pending_reqs[i].mutex);
      if (pending_reqs[i].req_id == req_id && !pending_reqs[i].done) {
        pending_reqs[i].result_node = node;
        pending_reqs[i].event_kind = event;
        pending_reqs[i].done = true;
        host_cond_signal(&pending_reqs[i].cond);
        found = true;
        host_mutex_unlock(&pending_reqs[i].mutex);
        break;
      }
      host_mutex_unlock(&pending_reqs[i].mutex);
    }

    if (!found) {
      unsigned long long dropped =
          atomic_fetch_add_explicit(&dispatcher_dropped, 1,
                                    memory_order_relaxed) +
          1;
      fprintf(stderr,
              "Dispatcher: dropped event req_id=%u kind=%u node=%u "
              "(dropped=%llu)\n",
              req_id, event, node, dropped);
    }
    /* Wake stdout pump so it can drain if a worker just enqueued. */
    host_mutex_lock(&pump_mutex);
    pump_wakeup_pending = true;
    host_cond_signal(&pump_cvar);
    host_mutex_unlock(&pump_mutex);
  }
  return NULL;
}

/* Consumes arena stdout ring. Publication is serialized so visible stdout
 * preserves the ring's FIFO order even when batch mode drains on DONE. */
static void *stdout_thread_main(void *arg) {
  (void)arg;
  while (atomic_load_explicit(&is_thanatos_initialized, memory_order_acquire)) {
    bool published = false;
    host_mutex_lock(&stdout_publish_mutex);
    published = publish_one_stdout_byte_locked();
    host_mutex_unlock(&stdout_publish_mutex);
    if (!published) {
      host_mutex_lock(&pump_mutex);
      while (atomic_load_explicit(&is_thanatos_initialized,
                                  memory_order_acquire) &&
             !pump_wakeup_pending) {
        host_cond_wait(&pump_cvar, &pump_mutex);
      }
      pump_wakeup_pending = false;
      host_mutex_unlock(&pump_mutex);
    }
  }
  host_mutex_lock(&stdout_publish_mutex);
  drain_stdout_locked();
  host_mutex_unlock(&stdout_publish_mutex);
  return NULL;
}

void thanatos_init(ThanatosConfig config) {
  if (atomic_load_explicit(&is_thanatos_initialized, memory_order_acquire))
    return;

  if (config.arena_capacity == 0)
    config.arena_capacity = 1 << 24;
  if (config.num_workers == 0)
    config.num_workers = host_cpu_count();

  uint32_t arena_ptr = initArena(config.arena_capacity);
  if (arena_ptr == 0) {
    fprintf(stderr,
            "Thanatos: initArena failed for arena_capacity=%u "
            "(max_supported=%u, power_of_two_required=1)\n",
            config.arena_capacity, arena_max_capacity());
    abort();
  }

  if (!runtime_sync_initialized) {
    host_mutex_init(&io_wait_mutex);
    host_mutex_init(&stdout_publish_mutex);
    host_mutex_init(&stdin_demand_mutex);
    host_mutex_init(&pump_mutex);
    host_mutex_init(&pending_req_mutex);
    host_cond_init(&stdin_demand_cvar);
    host_cond_init(&pump_cvar);
    host_cond_init(&pending_req_cvar);
    runtime_sync_initialized = true;
  }


  host_runtime_input_close();
  runtime_stdin_available = false;
  if (config.stdin_path != NULL && config.stdin_path[0] != '\0' &&
      !host_runtime_input_open(config.stdin_path)) {
    fprintf(stderr, "Thanatos: cannot open runtime stdin path %s\n",
            config.stdin_path);
  } else if (config.stdin_path != NULL && config.stdin_path[0] != '\0') {
    runtime_stdin_available = true;
  }
  stdin_demand_count = 0;

  for (int i = 0; i < MAX_PENDING_REQS; i++) {
    pending_reqs[i].req_id = 0;
    pending_reqs[i].done = false;
    host_mutex_init(&pending_reqs[i].mutex);
    host_cond_init(&pending_reqs[i].cond);
  }
  for (int i = 0; i < MAX_IO_WAIT; i++) {
    io_wait_map[i].node_id = EMPTY;
    io_wait_map[i].req_id = 0;
  }

  atomic_store_explicit(&dispatcher_events, 0, memory_order_relaxed);
  atomic_store_explicit(&dispatcher_dropped, 0, memory_order_relaxed);
  atomic_store_explicit(&next_req_id, 1, memory_order_release);
  pump_wakeup_pending = false;


  num_workers_count = config.num_workers;
  workers = malloc(sizeof(HostThread) * num_workers_count);
}

void thanatos_start_threads(bool enable_stdout_pump) {
  if (atomic_load_explicit(&is_thanatos_initialized, memory_order_acquire))
    return;
  atomic_store_explicit(&is_thanatos_initialized, true, memory_order_release);

  for (uint32_t i = 0; i < num_workers_count; i++) {
    must_thread_create(&workers[i], worker_thread_main, (void *)(uintptr_t)i,
                       "worker");
  }

  must_thread_create(&dispatcher_thread, dispatcher_thread_main, NULL,
                     "dispatcher");
  if (runtime_stdin_available) {
    must_thread_create(&stdin_thread, stdin_thread_main, NULL, "stdin");
    stdin_thread_started = true;
  } else {
    stdin_thread_started = false;
  }
  if (enable_stdout_pump) {
    must_thread_create(&stdout_thread, stdout_thread_main, NULL, "stdout");
    stdout_thread_started = true;
  } else {
    stdout_thread_started = false;
  }
}

uint32_t thanatos_reduce(uint32_t node_id, uint32_t max_steps) {
  uint32_t req_id = atomic_fetch_add(&next_req_id, 1);
  uint32_t current_node = node_id;

  int slot = -1;
  while (slot == -1) {
    host_mutex_lock(&pending_req_mutex);
    for (int i = 0; i < MAX_PENDING_REQS; i++) {
      host_mutex_lock(&pending_reqs[i].mutex);
      if (pending_reqs[i].req_id == 0) {
        pending_reqs[i].req_id = req_id;
        pending_reqs[i].done = false;
        slot = i;
        host_mutex_unlock(&pending_reqs[i].mutex);
        break;
      }
      host_mutex_unlock(&pending_reqs[i].mutex);
    }
    if (slot == -1) {
      host_cond_wait(&pending_req_cvar, &pending_req_mutex);
    }
    host_mutex_unlock(&pending_req_mutex);
  }

  while (hostSubmit(current_node, req_id, max_steps) != 0) {
    /* yield until submit succeeds */
    host_yield();
  }

  while (true) {
    host_mutex_lock(&pending_reqs[slot].mutex);
    while (!pending_reqs[slot].done) {
      host_cond_wait(&pending_reqs[slot].cond, &pending_reqs[slot].mutex);
    }

    uint32_t node = pending_reqs[slot].result_node;
    uint32_t event = pending_reqs[slot].event_kind;
    bool step_budget_exhausted =
        (event == CQ_EVENT_YIELD) && (max_steps != 0xffffffffu) &&
        is_control_ptr(node) &&
        (controlSuspensionReason(node) == SUSP_STEP_LIMIT) &&
        (controlSuspensionRemainingSteps(node) == 0);

    if (event == CQ_EVENT_DONE || step_budget_exhausted) {
      host_mutex_unlock(&pending_reqs[slot].mutex);
      release_pending_req_slot(slot);
      /* Drain any remaining arena stdout bytes before main prints the result
       * line. Publication is serialized with the pump to preserve FIFO order.
       */
      host_mutex_lock(&stdout_publish_mutex);
      drain_stdout_locked();
      host_mutex_unlock(&stdout_publish_mutex);
      return node;
    } else if (event == CQ_EVENT_IO_WAIT) {
      io_wait_register(node, req_id);
      bool is_stdin = io_wait_is_stdin(node);
      pending_reqs[slot].done = false;
      host_mutex_unlock(&pending_reqs[slot].mutex);
      if (is_stdin) {
        if (stdin_thread_started) {
          host_mutex_lock(&stdin_demand_mutex);
          stdin_demand_count++;
          host_cond_signal(&stdin_demand_cvar);
          host_mutex_unlock(&stdin_demand_mutex);
        }
      } else {
        /* Stdout wait: pump will dequeue from stdout_wait and resubmit. */
      }
    } else if (event == CQ_EVENT_YIELD) {
      current_node = node;
      pending_reqs[slot].done = false;
      host_mutex_unlock(&pending_reqs[slot].mutex);

      while (hostSubmit(current_node, req_id, 0) != 0) {
        host_yield();
      }
    } else {
      fprintf(stderr, "Thanatos: error for req_id %u\n", req_id);
      host_mutex_unlock(&pending_reqs[slot].mutex);
      release_pending_req_slot(slot);
      return EMPTY;
    }
  }
}

uint32_t thanatos_reduce_to_normal_form(uint32_t node_id) {
  return thanatos_reduce(node_id, 0xffffffffu);
}

void thanatos_get_stats(uint32_t *out_top, uint32_t *out_capacity,
                        unsigned long long *out_total_nodes,
                        unsigned long long *out_total_steps,
                        unsigned long long *out_total_link_chase_hops,
                        unsigned long long *out_total_cons_allocs,
                        unsigned long long *out_total_cont_allocs,
                        unsigned long long *out_total_susp_allocs,
                        unsigned long long *out_duplicate_lost_allocs,
                        unsigned long long *out_hashcons_hits,
                        unsigned long long *out_hashcons_misses,
                        unsigned long long *out_bulk_fusion_checks,
                        unsigned long long *out_bulk_fusion_candidates,
                        unsigned long long *out_bulk_fusion_hits,
                        unsigned long long *out_events,
                        unsigned long long *out_dropped) {
  if (out_top)
    *out_top = arena_top();
  if (out_capacity)
    *out_capacity = arena_capacity();
  if (out_total_nodes)
    *out_total_nodes = arena_total_nodes();
  if (out_total_steps)
    *out_total_steps = arena_total_steps();
  if (out_total_link_chase_hops)
    *out_total_link_chase_hops = arena_total_link_chase_hops();
  if (out_total_cons_allocs)
    *out_total_cons_allocs = arena_total_cons_allocs();
  if (out_total_cont_allocs)
    *out_total_cont_allocs = arena_total_cont_allocs();
  if (out_total_susp_allocs)
    *out_total_susp_allocs = arena_total_susp_allocs();
  if (out_duplicate_lost_allocs)
    *out_duplicate_lost_allocs = arena_duplicate_lost_allocs();
  if (out_hashcons_hits)
    *out_hashcons_hits = arena_hashcons_hits();
  if (out_hashcons_misses)
    *out_hashcons_misses = arena_hashcons_misses();
  if (out_bulk_fusion_checks)
    *out_bulk_fusion_checks = arena_bulk_fusion_checks();
  if (out_bulk_fusion_candidates)
    *out_bulk_fusion_candidates = arena_bulk_fusion_candidates();
  if (out_bulk_fusion_hits)
    *out_bulk_fusion_hits = arena_bulk_fusion_hits();

  if (out_events)
    *out_events =
        atomic_load_explicit(&dispatcher_events, memory_order_relaxed);
  if (out_dropped)
    *out_dropped =
        atomic_load_explicit(&dispatcher_dropped, memory_order_relaxed);
}

void thanatos_debug_pending_requests(uint32_t *out_active, uint32_t *out_done) {
  uint32_t active = 0;
  uint32_t done = 0;
  for (int i = 0; i < MAX_PENDING_REQS; i++) {
    host_mutex_lock(&pending_reqs[i].mutex);
    if (pending_reqs[i].req_id != 0) {
      active++;
      if (pending_reqs[i].done)
        done++;
    }
    host_mutex_unlock(&pending_reqs[i].mutex);
  }
  if (out_active)
    *out_active = active;
  if (out_done)
    *out_done = done;
}

void thanatos_reset_stats(void) {
  atomic_store_explicit(&dispatcher_events, 0, memory_order_release);
  atomic_store_explicit(&dispatcher_dropped, 0, memory_order_release);
}

void thanatos_shutdown(void) {
  if (!atomic_load_explicit(&is_thanatos_initialized, memory_order_acquire))
    return;
  atomic_store_explicit(&is_thanatos_initialized, false, memory_order_release);

  if (stdin_thread_started) {
    host_mutex_lock(&stdin_demand_mutex);
    host_cond_signal(&stdin_demand_cvar);
    host_mutex_unlock(&stdin_demand_mutex);
    host_runtime_input_close();
    host_thread_join(stdin_thread);
    stdin_thread_started = false;
  }
  if (stdout_thread_started) {
    host_mutex_lock(&pump_mutex);
    pump_wakeup_pending = true;
    host_cond_signal(&pump_cvar);
    host_mutex_unlock(&pump_mutex);
    host_thread_join(stdout_thread);
    stdout_thread_started = false;
  }
  /* Wake dispatcher from blocking CQ dequeue so it can exit */
  arena_cq_enqueue_shutdown_sentinel();
  host_thread_join(dispatcher_thread);
  fprintf(stderr, "Dispatcher: stopped events=%llu dropped=%llu\n",
          atomic_load_explicit(&dispatcher_events, memory_order_relaxed),
          atomic_load_explicit(&dispatcher_dropped, memory_order_relaxed));
  for (int i = 0; i < MAX_PENDING_REQS; i++) {
    host_mutex_destroy(&pending_reqs[i].mutex);
    host_cond_destroy(&pending_reqs[i].cond);
  }
  host_runtime_input_close();
  if (runtime_sync_initialized) {
    host_mutex_destroy(&pump_mutex);
    host_mutex_destroy(&pending_req_mutex);
    host_cond_destroy(&pump_cvar);
    host_cond_destroy(&pending_req_cvar);
    host_mutex_destroy(&stdin_demand_mutex);
    host_cond_destroy(&stdin_demand_cvar);
    host_mutex_destroy(&stdout_publish_mutex);
    host_mutex_destroy(&io_wait_mutex);
    runtime_sync_initialized = false;
  }
  free(workers);
  workers = NULL;
}
