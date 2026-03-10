#include "thanatos.h"
#include <pthread.h>
#include <stdatomic.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>

#define MAX_PENDING_REQS 1024
#define MAX_IO_WAIT 1024

typedef struct {
  uint32_t req_id;
  uint32_t result_node;
  uint32_t event_kind;
  bool done;
  pthread_cond_t cond;
  pthread_mutex_t mutex;
} PendingReq;

typedef struct {
  uint32_t node_id;
  uint32_t req_id;
} IoWaitEntry;

static pthread_t *workers = NULL;
static uint32_t num_workers_count = 0;
static atomic_uint next_req_id = 1;
static atomic_bool is_thanatos_initialized = false;
static int dispatcher_trace = 0;
static atomic_ullong dispatcher_events = 0;
static atomic_ullong dispatcher_dropped = 0;
static pthread_t dispatcher_thread;
static pthread_t stdout_thread;
static bool stdout_thread_started = false;

/** Stdin source for batch mode (set from config at init). */
static const uint8_t *stdin_src = NULL;
static size_t stdin_src_len = 0;
static size_t *stdin_src_pos = NULL;

static PendingReq pending_reqs[MAX_PENDING_REQS];
static IoWaitEntry io_wait_map[MAX_IO_WAIT];
static pthread_mutex_t io_wait_mutex = PTHREAD_MUTEX_INITIALIZER;

/** Pump blocks on this when arena stdout ring is empty; dispatcher signals
 * after each CQE so pump wakes when there may be new stdout (no fixed sleep). */
static pthread_mutex_t pump_mutex = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t pump_cvar = PTHREAD_COND_INITIALIZER;

static void *worker_thread_main(void *arg) {
  uint32_t worker_id = (uint32_t)(uintptr_t)arg;
  workerLoop(worker_id);
  return NULL;
}

/** Temporary: infer READ_ONE vs WRITE_ONE by walking the suspension's stored
 * term (left-spine to head). Fragile if representation changes; prefer encoding
 * IO wait reason in CQ_EVENT_IO_WAIT or suspension tag (e.g. IO_WAIT_READ /
 * IO_WAIT_WRITE) for a durable mechanism. */
static bool io_wait_is_stdin(uint32_t node_id) {
  uint32_t curr = leftOf(node_id);
  uint32_t head = curr;
  while (kindOf(head) == ARENA_KIND_NON_TERM)
    head = leftOf(head);
  if (kindOf(head) != ARENA_KIND_TERMINAL)
    return false;
  return symOf(head) == ARENA_SYM_READ_ONE;
}

static void io_wait_register(uint32_t node_id, uint32_t req_id) {
  pthread_mutex_lock(&io_wait_mutex);
  for (int i = 0; i < MAX_IO_WAIT; i++) {
    if (io_wait_map[i].node_id == EMPTY) {
      io_wait_map[i].node_id = node_id;
      io_wait_map[i].req_id = req_id;
      pthread_mutex_unlock(&io_wait_mutex);
      return;
    }
  }
  pthread_mutex_unlock(&io_wait_mutex);
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
  pthread_mutex_lock(&io_wait_mutex);
  for (int i = 0; i < MAX_IO_WAIT; i++) {
    if (io_wait_map[i].node_id == node_id) {
      uint32_t req_id = io_wait_map[i].req_id;
      io_wait_map[i].node_id = EMPTY;
      io_wait_map[i].req_id = 0;
      pthread_mutex_unlock(&io_wait_mutex);
      return req_id;
    }
  }
  pthread_mutex_unlock(&io_wait_mutex);
  return 0;
}

extern uint8_t *ARENA_BASE_ADDR;

__attribute__((no_sanitize("address"))) static void *
dispatcher_thread_main(void *arg) {
  (void)arg;
  fprintf(stderr, "Dispatcher: started, base=%p\n", (void *)ARENA_BASE_ADDR);
  while (atomic_load_explicit(&is_thanatos_initialized, memory_order_acquire)) {
    if (ARENA_BASE_ADDR) {
      SabHeader *h = (SabHeader *)ARENA_BASE_ADDR;
      if (h->magic != 0x534B4941) {
        printf("Dispatcher: magic mismatch! expected 0x534B4941, got 0x%x\n",
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
    uint32_t node = cqe.node_id & 0x3fffffff;
    unsigned long long seq =
        atomic_fetch_add_explicit(&dispatcher_events, 1, memory_order_relaxed) +
        1;
    if (dispatcher_trace) {
      printf("Dispatcher: event=%llu req_id=%u kind=%u node=%u\n", seq, req_id,
             event, node);
    }

    bool found = false;
    for (int i = 0; i < MAX_PENDING_REQS; i++) {
      pthread_mutex_lock(&pending_reqs[i].mutex);
      if (pending_reqs[i].req_id == req_id && !pending_reqs[i].done) {
        pending_reqs[i].result_node = node;
        pending_reqs[i].event_kind = event;
        pending_reqs[i].done = true;
        pthread_cond_signal(&pending_reqs[i].cond);
        found = true;
        pthread_mutex_unlock(&pending_reqs[i].mutex);
        break;
      }
      pthread_mutex_unlock(&pending_reqs[i].mutex);
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
    pthread_cond_signal(&pump_cvar);
  }
  return NULL;
}

/* Consumes arena stdout ring; thanatos_reduce() also drains on DONE. Both
 * consume the same ring—ordering is race-dependent. Fine for batch mode. */
static void *stdout_thread_main(void *arg) {
  (void)arg;
  uint8_t byte;
  while (atomic_load_explicit(&is_thanatos_initialized, memory_order_acquire)) {
    if (arena_stdout_try_pop(&byte)) {
      putchar(byte);
      fflush(stdout);
      /* Wake one stdout waiter so it can retry enqueue. */
      uint32_t woke_node;
      if (arena_stdout_wait_try_dequeue(&woke_node)) {
        uint32_t woke_req = io_wait_remove(woke_node);
        if (woke_req != 0) {
          while (hostSubmit(woke_node, woke_req, 0) != 0) { /* spin */
          }
        }
      }
    } else {
      pthread_mutex_lock(&pump_mutex);
      pthread_cond_wait(&pump_cvar, &pump_mutex);
      pthread_mutex_unlock(&pump_mutex);
    }
  }
  while (arena_stdout_try_pop(&byte)) {
    putchar(byte);
    uint32_t woke_node;
    if (arena_stdout_wait_try_dequeue(&woke_node)) {
      uint32_t woke_req = io_wait_remove(woke_node);
      if (woke_req != 0) {
        while (hostSubmit(woke_node, woke_req, 0) != 0) { /* spin */
        }
      }
    }
  }
  fflush(stdout);
  return NULL;
}

void thanatos_init(ThanatosConfig config) {
  if (atomic_load_explicit(&is_thanatos_initialized, memory_order_acquire))
    return;

  if (config.arena_capacity == 0)
    config.arena_capacity = 1 << 24;
  if (config.num_workers == 0) {
    long n = sysconf(_SC_NPROCESSORS_ONLN);
    config.num_workers = (n > 0 && n <= 0xffffffffu) ? (uint32_t)n : 4;
  }

  initArena(config.arena_capacity);

  stdin_src = config.stdin_bytes;
  stdin_src_len = config.stdin_len;
  stdin_src_pos = config.stdin_pos;

  for (int i = 0; i < MAX_PENDING_REQS; i++) {
    pending_reqs[i].req_id = 0;
    pending_reqs[i].done = false;
    pthread_mutex_init(&pending_reqs[i].mutex, NULL);
    pthread_cond_init(&pending_reqs[i].cond, NULL);
  }
  for (int i = 0; i < MAX_IO_WAIT; i++) {
    io_wait_map[i].node_id = EMPTY;
    io_wait_map[i].req_id = 0;
  }

  const char *trace_env = getenv("THANATOS_TRACE");
  dispatcher_trace =
      (trace_env != NULL && trace_env[0] != '\0' && trace_env[0] != '0');
  atomic_store_explicit(&dispatcher_events, 0, memory_order_relaxed);
  atomic_store_explicit(&dispatcher_dropped, 0, memory_order_relaxed);

  num_workers_count = config.num_workers;
  workers = malloc(sizeof(pthread_t) * num_workers_count);
}

void thanatos_start_threads(bool enable_stdout_pump) {
  if (atomic_load_explicit(&is_thanatos_initialized, memory_order_acquire))
    return;
  atomic_store_explicit(&is_thanatos_initialized, true, memory_order_release);

  for (uint32_t i = 0; i < num_workers_count; i++) {
    pthread_create(&workers[i], NULL, worker_thread_main, (void *)(uintptr_t)i);
  }

  pthread_create(&dispatcher_thread, NULL, dispatcher_thread_main, NULL);
  if (enable_stdout_pump) {
    pthread_create(&stdout_thread, NULL, stdout_thread_main, NULL);
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
    for (int i = 0; i < MAX_PENDING_REQS; i++) {
      pthread_mutex_lock(&pending_reqs[i].mutex);
      if (pending_reqs[i].req_id == 0) {
        pending_reqs[i].req_id = req_id;
        pending_reqs[i].done = false;
        slot = i;
        pthread_mutex_unlock(&pending_reqs[i].mutex);
        break;
      }
      pthread_mutex_unlock(&pending_reqs[i].mutex);
    }
  }

  while (hostSubmit(current_node, req_id, max_steps) != 0) {
    /* spin until submit succeeds */
  }

  while (true) {
    pthread_mutex_lock(&pending_reqs[slot].mutex);
    while (!pending_reqs[slot].done) {
      pthread_cond_wait(&pending_reqs[slot].cond, &pending_reqs[slot].mutex);
    }

    uint32_t node = pending_reqs[slot].result_node;
    uint32_t event = pending_reqs[slot].event_kind;
    bool step_budget_exhausted =
        (event == CQ_EVENT_YIELD) && (max_steps != 0xffffffffu) &&
        (kindOf(node) == ARENA_KIND_SUSPENSION) &&
        (symOf(node) != MODE_IO_WAIT) && (hashOf(node) == 0);

    if (event == CQ_EVENT_DONE || step_budget_exhausted) {
      pending_reqs[slot].req_id = 0;
      pthread_mutex_unlock(&pending_reqs[slot].mutex);
      /* Drain any arena stdout bytes still in the ring so program output
       * appears before main's result line. stdout_thread_main() also consumes
       * this ring; both are consumers of the same ring, so output ordering
       * is partly race-dependent. For batch mode this is acceptable. */
      uint8_t byte;
      while (arena_stdout_try_pop(&byte)) {
        putchar(byte);
      }
      fflush(stdout);
      return node;
    } else if (event == CQ_EVENT_IO_WAIT) {
      io_wait_register(node, req_id);
      bool is_stdin = io_wait_is_stdin(node);
      if (is_stdin) {
        if (stdin_src && stdin_src_pos && *stdin_src_pos < stdin_src_len) {
          uint8_t byte = stdin_src[*stdin_src_pos];
          (*stdin_src_pos)++;
          arena_stdin_push(byte);
          (void)io_wait_remove(node);
          while (hostSubmit(node, req_id, 0) != 0) { /* spin */
          }
          pending_reqs[slot].done = false;
          pthread_mutex_unlock(&pending_reqs[slot].mutex);
        } else {
          fprintf(stderr, "Thanatos: stdin exhausted (req_id %u)\n", req_id);
          (void)io_wait_remove(node);
          pending_reqs[slot].req_id = 0;
          pthread_mutex_unlock(&pending_reqs[slot].mutex);
          return EMPTY;
        }
      } else {
        /* Stdout wait: pump will dequeue from stdout_wait and resubmit. */
        pending_reqs[slot].done = false;
        pthread_mutex_unlock(&pending_reqs[slot].mutex);
      }
    } else if (event == CQ_EVENT_YIELD) {
      current_node = node;
      pending_reqs[slot].done = false;
      pthread_mutex_unlock(&pending_reqs[slot].mutex);

      while (hostSubmit(current_node, req_id, 0) != 0) {
        /* spin until submit succeeds */
      }
    } else {
      fprintf(stderr, "Thanatos: error for req_id %u\n", req_id);
      pending_reqs[slot].req_id = 0;
      pthread_mutex_unlock(&pending_reqs[slot].mutex);
      return EMPTY;
    }
  }
}

uint32_t thanatos_reduce_to_normal_form(uint32_t node_id) {
  return thanatos_reduce(node_id, 0xffffffffu);
}

void thanatos_get_stats(uint32_t *out_top, uint32_t *out_capacity,
                        unsigned long long *out_events,
                        unsigned long long *out_dropped) {
  if (out_top)
    *out_top = arena_top();
  if (out_capacity)
    *out_capacity = arena_capacity();
  if (out_events)
    *out_events =
        atomic_load_explicit(&dispatcher_events, memory_order_relaxed);
  if (out_dropped)
    *out_dropped =
        atomic_load_explicit(&dispatcher_dropped, memory_order_relaxed);
}

void thanatos_shutdown(void) {
  if (!atomic_load_explicit(&is_thanatos_initialized, memory_order_acquire))
    return;
  atomic_store_explicit(&is_thanatos_initialized, false, memory_order_release);

  if (stdout_thread_started) {
    pthread_mutex_lock(&pump_mutex);
    pthread_cond_signal(&pump_cvar);
    pthread_mutex_unlock(&pump_mutex);
    pthread_join(stdout_thread, NULL);
    pthread_mutex_destroy(&pump_mutex);
    pthread_cond_destroy(&pump_cvar);
    stdout_thread_started = false;
  }
  /* Wake dispatcher from blocking CQ dequeue so it can exit */
  arena_cq_enqueue_shutdown_sentinel();
  pthread_join(dispatcher_thread, NULL);
  fprintf(stderr, "Dispatcher: stopped events=%llu dropped=%llu\n",
          atomic_load_explicit(&dispatcher_events, memory_order_relaxed),
          atomic_load_explicit(&dispatcher_dropped, memory_order_relaxed));
  for (int i = 0; i < MAX_PENDING_REQS; i++) {
    pthread_mutex_destroy(&pending_reqs[i].mutex);
    pthread_cond_destroy(&pending_reqs[i].cond);
  }
  free(workers);
}
