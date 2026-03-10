#include "thanatos.h"
#include <errno.h>
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
static pthread_t stdin_thread;
static bool stdout_thread_started = false;
static bool stdin_thread_started = false;

/** Optional runtime stdin stream for READ_ONE (set from config at init). */
static int stdin_stream_fd = -1;

static PendingReq pending_reqs[MAX_PENDING_REQS];
static IoWaitEntry io_wait_map[MAX_IO_WAIT];
static pthread_mutex_t io_wait_mutex = PTHREAD_MUTEX_INITIALIZER;
static pthread_mutex_t stdout_publish_mutex = PTHREAD_MUTEX_INITIALIZER;
static pthread_mutex_t stdin_demand_mutex = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t stdin_demand_cvar = PTHREAD_COND_INITIALIZER;
static uint32_t stdin_demand_count = 0;

/** Pump blocks on this when arena stdout ring is empty; dispatcher signals
 * after each CQE so pump wakes when there may be new stdout (no fixed sleep).
 */
static pthread_mutex_t pump_mutex = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t pump_cvar = PTHREAD_COND_INITIALIZER;
static bool pump_wakeup_pending = false;

static uint32_t io_wait_remove(uint32_t node_id);

static void must_pthread_create(pthread_t *thread, void *(*entry)(void *),
                                void *arg, const char *name) {
  int rc = pthread_create(thread, NULL, entry, arg);
  if (rc != 0) {
    fprintf(stderr, "Thanatos: pthread_create(%s) failed (rc=%d)\n", name, rc);
    abort();
  }
}

static void wake_one_stdin_waiter(void) {
  uint32_t woke_node;
  if (arena_stdin_wait_try_dequeue(&woke_node)) {
    uint32_t woke_req = io_wait_remove(woke_node);
    if (woke_req != 0) {
      while (hostSubmit(woke_node, woke_req, 0) != 0) { /* spin */
      }
    }
  }
}

static void wake_one_stdout_waiter(void) {
  uint32_t woke_node;
  if (arena_stdout_wait_try_dequeue(&woke_node)) {
    uint32_t woke_req = io_wait_remove(woke_node);
    if (woke_req != 0) {
      while (hostSubmit(woke_node, woke_req, 0) != 0) { /* spin */
      }
    }
  }
}

static bool publish_one_stdout_byte_locked(void) {
  uint8_t byte;
  if (!arena_stdout_try_pop(&byte))
    return false;
  putchar(byte);
  wake_one_stdout_waiter();
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
  if (byte_out == NULL || stdin_stream_fd < 0)
    return false;
  while (atomic_load_explicit(&is_thanatos_initialized, memory_order_acquire)) {
    ssize_t n = read(stdin_stream_fd, byte_out, 1);
    if (n == 1)
      return true;
    if (n == 0 || errno == EAGAIN || errno == EWOULDBLOCK) {
      usleep(1000);
      continue;
    }
    if (errno == EINTR)
      continue;
    if (errno == EBADF &&
        !atomic_load_explicit(&is_thanatos_initialized, memory_order_acquire)) {
      return false;
    }
    fprintf(stderr, "Thanatos: stdin read failed (errno=%d); retrying\n",
            errno);
    usleep(1000);
  }
  return false;
}

static void *stdin_thread_main(void *arg) {
  (void)arg;
  while (atomic_load_explicit(&is_thanatos_initialized, memory_order_acquire)) {
    pthread_mutex_lock(&stdin_demand_mutex);
    while (
        atomic_load_explicit(&is_thanatos_initialized, memory_order_acquire) &&
        stdin_demand_count == 0) {
      pthread_cond_wait(&stdin_demand_cvar, &stdin_demand_mutex);
    }
    if (!atomic_load_explicit(&is_thanatos_initialized, memory_order_acquire)) {
      pthread_mutex_unlock(&stdin_demand_mutex);
      break;
    }
    stdin_demand_count--;
    pthread_mutex_unlock(&stdin_demand_mutex);

    uint8_t byte;
    if (!read_stdin_byte_blocking(&byte))
      break;
    arena_stdin_push(byte);
    wake_one_stdin_waiter();
  }
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
    pthread_mutex_lock(&pump_mutex);
    pump_wakeup_pending = true;
    pthread_cond_signal(&pump_cvar);
    pthread_mutex_unlock(&pump_mutex);
  }
  return NULL;
}

/* Consumes arena stdout ring. Publication is serialized so visible stdout
 * preserves the ring's FIFO order even when batch mode drains on DONE. */
static void *stdout_thread_main(void *arg) {
  (void)arg;
  while (atomic_load_explicit(&is_thanatos_initialized, memory_order_acquire)) {
    bool published = false;
    pthread_mutex_lock(&stdout_publish_mutex);
    published = publish_one_stdout_byte_locked();
    if (published)
      fflush(stdout);
    pthread_mutex_unlock(&stdout_publish_mutex);
    if (!published) {
      pthread_mutex_lock(&pump_mutex);
      while (atomic_load_explicit(&is_thanatos_initialized,
                                  memory_order_acquire) &&
             !pump_wakeup_pending) {
        pthread_cond_wait(&pump_cvar, &pump_mutex);
      }
      pump_wakeup_pending = false;
      pthread_mutex_unlock(&pump_mutex);
    }
  }
  pthread_mutex_lock(&stdout_publish_mutex);
  drain_stdout_locked();
  pthread_mutex_unlock(&stdout_publish_mutex);
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

  stdin_stream_fd = config.stdin_fd;
  stdin_demand_count = 0;

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
  pump_wakeup_pending = false;

  num_workers_count = config.num_workers;
  workers = malloc(sizeof(pthread_t) * num_workers_count);
}

void thanatos_start_threads(bool enable_stdout_pump) {
  if (atomic_load_explicit(&is_thanatos_initialized, memory_order_acquire))
    return;
  atomic_store_explicit(&is_thanatos_initialized, true, memory_order_release);

  for (uint32_t i = 0; i < num_workers_count; i++) {
    must_pthread_create(&workers[i], worker_thread_main, (void *)(uintptr_t)i,
                        "worker");
  }

  must_pthread_create(&dispatcher_thread, dispatcher_thread_main, NULL,
                      "dispatcher");
  if (stdin_stream_fd >= 0) {
    must_pthread_create(&stdin_thread, stdin_thread_main, NULL, "stdin");
    stdin_thread_started = true;
  } else {
    stdin_thread_started = false;
  }
  if (enable_stdout_pump) {
    must_pthread_create(&stdout_thread, stdout_thread_main, NULL, "stdout");
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
      /* Drain any remaining arena stdout bytes before main prints the result
       * line. Publication is serialized with the pump to preserve FIFO order.
       */
      pthread_mutex_lock(&stdout_publish_mutex);
      drain_stdout_locked();
      pthread_mutex_unlock(&stdout_publish_mutex);
      return node;
    } else if (event == CQ_EVENT_IO_WAIT) {
      io_wait_register(node, req_id);
      bool is_stdin = io_wait_is_stdin(node);
      pending_reqs[slot].done = false;
      pthread_mutex_unlock(&pending_reqs[slot].mutex);
      if (is_stdin) {
        if (stdin_thread_started) {
          pthread_mutex_lock(&stdin_demand_mutex);
          stdin_demand_count++;
          pthread_cond_signal(&stdin_demand_cvar);
          pthread_mutex_unlock(&stdin_demand_mutex);
        }
      } else {
        /* Stdout wait: pump will dequeue from stdout_wait and resubmit. */
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

  if (stdin_thread_started) {
    pthread_mutex_lock(&stdin_demand_mutex);
    pthread_cond_signal(&stdin_demand_cvar);
    pthread_mutex_unlock(&stdin_demand_mutex);
    if (stdin_stream_fd >= 0) {
      close(stdin_stream_fd);
      stdin_stream_fd = -1;
    }
    pthread_join(stdin_thread, NULL);
    stdin_thread_started = false;
  }
  if (stdout_thread_started) {
    pthread_mutex_lock(&pump_mutex);
    pump_wakeup_pending = true;
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
  if (stdin_stream_fd >= 0) {
    close(stdin_stream_fd);
    stdin_stream_fd = -1;
  }
  free(workers);
}
