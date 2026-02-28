#include "thanatos.h"
#include <pthread.h>
#include <stdatomic.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>

#define MAX_PENDING_REQS 1024

typedef struct {
  uint32_t req_id;
  uint32_t result_node;
  uint32_t event_kind;
  bool done;
  pthread_cond_t cond;
  pthread_mutex_t mutex;
} PendingReq;

static pthread_t *workers = NULL;
static uint32_t num_workers_count = 0;
static atomic_uint next_req_id = 1;
static atomic_bool is_thanatos_initialized = false;
static int dispatcher_trace = 0;
static atomic_ullong dispatcher_events = 0;
static atomic_ullong dispatcher_dropped = 0;
static pthread_t dispatcher_thread;
static pthread_t stdout_thread;

static PendingReq pending_reqs[MAX_PENDING_REQS];

static void *worker_thread_main(void *arg) {
  (void)arg;
  workerLoop();
  return NULL;
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
  }
  return NULL;
}

static void *stdout_thread_main(void *arg) {
  (void)arg;
  uint8_t byte;
  while (atomic_load_explicit(&is_thanatos_initialized, memory_order_acquire)) {
    if (arena_stdout_try_pop(&byte)) {
      putchar(byte);
      fflush(stdout);
    }
  }
  while (arena_stdout_try_pop(&byte)) {
    putchar(byte);
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

  for (int i = 0; i < MAX_PENDING_REQS; i++) {
    pending_reqs[i].req_id = 0;
    pending_reqs[i].done = false;
    pthread_mutex_init(&pending_reqs[i].mutex, NULL);
    pthread_cond_init(&pending_reqs[i].cond, NULL);
  }

  const char *trace_env = getenv("THANATOS_TRACE");
  dispatcher_trace =
      (trace_env != NULL && trace_env[0] != '\0' && trace_env[0] != '0');
  atomic_store_explicit(&dispatcher_events, 0, memory_order_relaxed);
  atomic_store_explicit(&dispatcher_dropped, 0, memory_order_relaxed);

  num_workers_count = config.num_workers;
  workers = malloc(sizeof(pthread_t) * num_workers_count);
}

void thanatos_start_threads(void) {
  if (atomic_load_explicit(&is_thanatos_initialized, memory_order_acquire))
    return;
  atomic_store_explicit(&is_thanatos_initialized, true, memory_order_release);

  for (uint32_t i = 0; i < num_workers_count; i++) {
    pthread_create(&workers[i], NULL, worker_thread_main, NULL);
  }

  pthread_create(&dispatcher_thread, NULL, dispatcher_thread_main, NULL);
  pthread_create(&stdout_thread, NULL, stdout_thread_main, NULL);
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
      return node;
    } else if (event == CQ_EVENT_IO_WAIT) {
      /* TODO: support IO instructions; for now treat as error. */
      fprintf(stderr, "Thanatos: IO instruction not supported (req_id %u)\n",
              req_id);
      pending_reqs[slot].req_id = 0;
      pthread_mutex_unlock(&pending_reqs[slot].mutex);
      return EMPTY;
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

void thanatos_shutdown(void) {
  if (!atomic_load_explicit(&is_thanatos_initialized, memory_order_acquire))
    return;
  atomic_store_explicit(&is_thanatos_initialized, false, memory_order_release);

  pthread_join(stdout_thread, NULL);
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
