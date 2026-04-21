#ifdef _WIN32
#ifndef _CRT_SECURE_NO_WARNINGS
#define _CRT_SECURE_NO_WARNINGS
#endif
#endif

#include "arena.h"
#include "host_platform.h"

#ifdef __wasm__
typedef __SIZE_TYPE__ size_t;
void *memcpy(void *dest, const void *src, size_t n) {
  return __builtin_memcpy(dest, src, n);
}
void *memset(void *s, int c, size_t n) { return __builtin_memset(s, c, n); }
void *memmove(void *dest, const void *src, size_t n) {
  return __builtin_memmove(dest, src, n);
}
#define WASM_PAGE_SIZE 65536
#define IMPORT_MEMORY                                                          \
  __attribute__((import_module("env"), import_name("memory")))
#else
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#ifndef _WIN32
#include <unistd.h>
#endif
#ifdef __linux__
#include <sys/syscall.h>
#endif
#endif

static const uint32_t ARENA_MAGIC = 0x534B4941;
static const uint32_t INITIAL_CAP = 1 << 16;
/** Gas per kernel step / worker batch; bounds time per step. */
static const uint32_t ARENA_STEP_GAS = 20000;
static const uint32_t MAX_CAP = 1 << 26;
static const uint32_t RING_ENTRIES = 1 << 16;
static const uint32_t POISON_SEQ = 0xffffffff;

typedef enum {
  IMMEDIATE_HEAD_NONE = 0,
  IMMEDIATE_HEAD_J = 1,
  IMMEDIATE_HEAD_V = 2,
  IMMEDIATE_HEAD_OTHER = 3,
} ImmediateHeadSummary;

enum {
  /* Reserved scratch slice for synchronous host-side arenaKernelStep(). */
  CONTROL_SYNC_SLICE_ID = MAX_WORKERS,
  CONTROL_SLICE_COUNT = MAX_WORKERS + 1,
  CONTROL_MAX_FRAMES = 2048,
  CONTROL_CONT_SLOTS = 1024,
  CONTROL_SUSP_SLOTS = 2048,
  CONTROL_CONT_BASE = 1,
  CONTROL_SUSP_BASE = CONTROL_CONT_BASE + CONTROL_CONT_SLOTS,
  CONTROL_INVALID_INDEX = 0,
  CONT_FLAG_ALLOCATED = 0x1,
  SUSP_FLAG_ALLOCATED = 0x1,
};

/** Set by worker at batch start, cleared at batch end; allocators unregister
 * before grow(). */
#ifdef __wasm__
static uint32_t tls_worker_id = MAX_WORKERS;
#else
static _Thread_local uint32_t tls_worker_id = MAX_WORKERS;
#endif

uint8_t *ARENA_BASE_ADDR = NULL;
static uint32_t ARENA_MODE = 0;
/** Native only: actual mmap size reserved at init (layout uses uint64_t so no
 * overflow at MAX_CAP). */
#ifndef __wasm__
static size_t ARENA_RESERVED_BYTES = 0;
#endif

#ifndef __wasm__
/* Native mmap-backed file I/O is ambient arena state. The session layer treats
 * REDUCE_FILE as single-flight, so at most one file-backed reduction may be
 * active per process at a time.
 */
static uint8_t *mmap_stdin_buf = NULL;
static size_t mmap_stdin_size = 0;
static atomic_size_t mmap_stdin_cursor = 0;
/* Distinguishes an active empty file from "no file-backed stdin". */
static atomic_bool mmap_stdin_active = false;

static uint8_t *mmap_stdout_buf = NULL;
static size_t mmap_stdout_size = 0;
static atomic_size_t mmap_stdout_cursor = 0;

void arena_set_io_mmap(uint8_t *in_map, size_t in_size, uint8_t *out_map,
                       size_t out_size) {
  bool file_io_active = (in_map != NULL) || (in_size != 0) ||
                        (out_map != NULL) || (out_size != 0);
  mmap_stdin_buf = in_map;
  mmap_stdin_size = in_size;
  atomic_store_explicit(&mmap_stdin_cursor, 0, memory_order_release);
  mmap_stdout_buf = out_map;
  mmap_stdout_size = out_size;
  atomic_store_explicit(&mmap_stdout_cursor, 0, memory_order_release);
  atomic_store_explicit(&mmap_stdin_active, file_io_active,
                        memory_order_release);
}

size_t arena_get_mmap_out_cursor(void) {
  return atomic_load_explicit(&mmap_stdout_cursor, memory_order_acquire);
}
#else
void arena_set_io_mmap(uint8_t *in_map, size_t in_size, uint8_t *out_map,
                       size_t out_size) {
  (void)in_map;
  (void)in_size;
  (void)out_map;
  (void)out_size;
}

size_t arena_get_mmap_out_cursor(void) { return 0; }
#endif

static inline uint32_t align64(uint32_t x) { return (x + 63) & ~63u; }
static inline uint64_t align64_u64(uint64_t x) {
  return (x + 63) & ~(uint64_t)63;
}
static inline void worker_cooperative_yield(void);

static inline uint8_t immediate_head_summary_for_leaf_kind(uint8_t kind) {
  if (kind == ARENA_KIND_J)
    return IMMEDIATE_HEAD_J;
  if (kind == ARENA_KIND_V)
    return IMMEDIATE_HEAD_V;
  if (kind == 0)
    return IMMEDIATE_HEAD_NONE;
  return IMMEDIATE_HEAD_OTHER;
}

static inline bool immediate_head_summary_is_jv(uint8_t summary) {
  return summary == IMMEDIATE_HEAD_J || summary == IMMEDIATE_HEAD_V;
}

static inline void sys_wait32(atomic_uint *ptr, uint32_t expected) {
#ifdef __wasm__
  __builtin_wasm_memory_atomic_wait32((int *)ptr, (int)expected, -1);
#else
  host_wait_u32(ptr, expected);
#endif
}

static inline void sys_notify(atomic_uint *ptr, uint32_t count) {
#ifdef __wasm__
  __builtin_wasm_memory_atomic_notify((int *)ptr, count);
#else
  host_notify_u32(ptr, count);
#endif
}

static inline uint32_t ring_bytes(uint32_t entries, uint32_t slot_size) {
  uint32_t header = sizeof(Ring);
  uint32_t slot_stride = (4 + slot_size + 3) & ~3;
  return align64(header + entries * slot_stride);
}

typedef struct {
  atomic_uint seq;
} SlotHeader;

#define GET_SLOT(ring, i, slot_size)                                           \
  ((void *)((uint8_t *)(ring) + sizeof(Ring) +                                 \
            ((i) & (ring)->mask) * ((4 + (slot_size) + 3) & ~3)))

static bool try_enqueue(Ring *ring, const void *item, uint32_t slot_size) {
  while (true) {
    uint32_t t = atomic_load_explicit(&ring->tail, memory_order_relaxed);
    SlotHeader *slot = (SlotHeader *)GET_SLOT(ring, t, slot_size);
    uint32_t s = atomic_load_explicit(&slot->seq, memory_order_acquire);
    uint32_t diff = s - t;

    if (diff == 0) {
      uint32_t expected_t = t;
      if (atomic_compare_exchange_weak_explicit(&ring->tail, &expected_t, t + 1,
                                                memory_order_relaxed,
                                                memory_order_relaxed)) {
        memcpy((uint8_t *)slot + 4, item, slot_size);
        atomic_store_explicit(&slot->seq, t + 1, memory_order_release);
        atomic_fetch_add_explicit(&ring->not_empty, 1, memory_order_release);
        sys_notify(&ring->not_empty, 1);
        return true;
      }
    } else if ((int32_t)diff < 0) {
      return false;
    }
  }
}

static bool try_dequeue(Ring *ring, void *item, uint32_t slot_size) {
  while (true) {
    uint32_t h = atomic_load_explicit(&ring->head, memory_order_relaxed);
    SlotHeader *slot = (SlotHeader *)GET_SLOT(ring, h, slot_size);
    uint32_t s = atomic_load_explicit(&slot->seq, memory_order_acquire);
    uint32_t diff = s - (h + 1);

    if (diff == 0) {
      uint32_t expected_h = h;
      if (atomic_compare_exchange_weak_explicit(&ring->head, &expected_h, h + 1,
                                                memory_order_relaxed,
                                                memory_order_relaxed)) {
        memcpy(item, (uint8_t *)slot + 4, slot_size);
        atomic_store_explicit(&slot->seq, h + ring->mask + 1,
                              memory_order_release);
        atomic_fetch_add_explicit(&ring->not_full, 1, memory_order_release);
        sys_notify(&ring->not_full, 1);
        return true;
      }
    } else if ((int32_t)diff < 0) {
      return false;
    }
  }
}

static void enqueue_blocking(Ring *ring, const void *item, uint32_t slot_size) {
  while (!try_enqueue(ring, item, slot_size)) {
    uint32_t v = atomic_load_explicit(&ring->not_full, memory_order_acquire);
    if (try_enqueue(ring, item, slot_size))
      return;
    sys_wait32(&ring->not_full, v);
  }
}

static void dequeue_blocking(Ring *ring, void *item, uint32_t slot_size) {
  while (true) {
    if (try_dequeue(ring, item, slot_size))
      return;
    uint32_t v = atomic_load_explicit(&ring->not_empty, memory_order_acquire);
    if (try_dequeue(ring, item, slot_size))
      return;
    sys_wait32(&ring->not_empty, v);
  }
}

static void ring_init_at(void *ptr, uint32_t entries, uint32_t slot_size) {
  Ring *ring = (Ring *)ptr;
  atomic_init(&ring->head, 0);
  atomic_init(&ring->tail, 0);
  atomic_init(&ring->not_empty, 0);
  atomic_init(&ring->not_full, 0);
  ring->entries = entries;
  ring->mask = entries - 1;
  for (uint32_t i = 0; i < entries; i++) {
    SlotHeader *slot = (SlotHeader *)GET_SLOT(ring, i, slot_size);
    atomic_init(&slot->seq, i);
  }
}

/** AoS node: 32 bytes (id<<5 indexing); fixed address across grow(). */
typedef struct {
  atomic_uint left;
  atomic_uint right;
  atomic_uint hash32;
  atomic_uint next_idx;
  atomic_uchar kind;
  atomic_uchar sym;
  uint8_t padding[14];
} __attribute__((aligned(32))) ArenaNode;

enum {
  /*
   * Per-capacity arrays in the active layout:
   * u32: left, right, hash32, next_idx, link, buckets
   * u8: kind, sym
   */
  ACTIVE_LAYOUT_U32_ARRAY_COUNT = 6,
  ACTIVE_LAYOUT_U8_ARRAY_COUNT = 2,
  ACTIVE_LAYOUT_BYTES_PER_CAPACITY_SLOT =
      (int)(sizeof(atomic_uint) * ACTIVE_LAYOUT_U32_ARRAY_COUNT +
            sizeof(atomic_uchar) * ACTIVE_LAYOUT_U8_ARRAY_COUNT),
};

typedef struct {
  uint32_t current_val;
  uint32_t sp;
  uint32_t remaining_steps;
  uint8_t mode;
  uint8_t status;
  uint16_t reserved;
  uint32_t req_id;
} WorkerState;

enum {
  TRACE_RING_SIZE = 128,
  TRACE_STACK_SNAPSHOT = 64,
  TRACE_GRAPH_NODES = 48,
  TRACE_SPINE_NODES = 16,
  TRACE_GRAPH_BFS_LIMIT = 32,
};

typedef enum {
  TRACE_EV_JOB_START = 1,
  TRACE_EV_JOB_RESUME = 2,
  TRACE_EV_SAFEPOINT = 3,
  TRACE_EV_PARK = 4,
  TRACE_EV_DONE = 5,
  TRACE_EV_IO_WAIT = 6,
  TRACE_EV_STEP_LIMIT = 7,
} TraceEventKind;

typedef struct {
  uint64_t step;
  uint32_t kind;
  uint32_t a;
  uint32_t b;
  uint32_t c;
  uint32_t req_id;
} TraceEvent;

typedef struct {
  uint32_t node_id;
  uint32_t kind;
  uint32_t sym;
  uint32_t left;
  uint32_t right;
} TraceGraphNode;

typedef struct {
  uint32_t worker_id;
  uint32_t status;
  uint32_t req_id;
  uint32_t current_val;
  uint32_t remaining_steps;
  uint32_t mode;
  uint32_t control_depth;
  uint32_t control_base;
  uint32_t control_count;
  uint32_t event_count;
  uint32_t graph_count;
  uint64_t thread_id;
  uint64_t step_counter;
  Frame control_stack[TRACE_STACK_SNAPSHOT];
  TraceEvent recent_events[TRACE_RING_SIZE];
  TraceGraphNode focus_graph[TRACE_GRAPH_NODES];
} WorkerTraceSnapshot;

typedef struct {
  atomic_uint live_status;
  atomic_uint live_req_id;
  atomic_uint live_current_val;
  atomic_uint live_remaining_steps;
  atomic_uint live_mode;
  atomic_uint live_sp;
  atomic_uint last_seen_epoch;
  atomic_uint snapshot_epoch_done;
  _Atomic uint64_t live_thread_id;
  _Atomic uint64_t live_step_counter;
  atomic_uint ring_head;
  TraceEvent ring[TRACE_RING_SIZE];
  WorkerTraceSnapshot snapshot;
} WorkerTraceState;

#ifdef __wasm__
static WorkerTraceState WORKER_TRACE[MAX_WORKERS] __attribute__((unused));
static atomic_uint TRACE_REQUESTED_EPOCH __attribute__((unused));
static uint32_t TRACE_WORKER_COUNT __attribute__((unused)) = 0;
#else
static WorkerTraceState WORKER_TRACE[MAX_WORKERS];
static atomic_uint TRACE_REQUESTED_EPOCH;
static uint32_t TRACE_WORKER_COUNT = 0;
#endif

typedef struct {
  uint32_t current_val;
  uint32_t saved_sp;
  uint32_t remaining_steps;
  uint8_t mode;
  uint8_t flags;
  uint16_t reserved;
  uint32_t next_free;
  /* Simplicity-first snapshot: large but fixed and fragmentation-free. */
  Frame frames[CONTROL_MAX_FRAMES];
} ReifiedCont;

typedef struct {
  uint8_t reason;
  /* Concurrently claimed by workers during resume. */
  atomic_uchar status;
  uint16_t flags;
  uint32_t cont_ptr;
  uint32_t wait_token;
  uint32_t next_free;
} Suspension;

typedef struct {
  atomic_ullong cont_head;
  atomic_ullong susp_head;
  atomic_uint cont_in_use;
  atomic_uint cont_high_water;
  atomic_uint susp_in_use;
  atomic_uint susp_high_water;
  atomic_uint cooperative_retries;
  atomic_uint park_count;
  atomic_uint resume_count;
  atomic_uint worker_high_water[CONTROL_SLICE_COUNT];
} ControlHeader;

typedef struct {
  ControlHeader *header;
  Frame *worker_frames;
  ReifiedCont *conts;
  Suspension *suspensions;
} ControlViews;

typedef struct {
  uint32_t offset_sq;
  uint32_t offset_cq;
  uint32_t offset_stdin;
  uint32_t offset_stdout;
  uint32_t offset_stdin_wait;
  uint32_t offset_stdout_wait;
  uint32_t offset_control;
  uint32_t control_bytes;
  uint32_t offset_term_cache;
  uint64_t offset_node_left;
  uint64_t offset_node_right;
  uint64_t offset_node_hash32;
  uint64_t offset_node_next_idx;
  uint64_t offset_node_link;
  uint64_t offset_node_kind;
  uint64_t offset_node_sym;
  uint64_t offset_buckets;
  uint64_t total_size;
} SabLayout;

static inline uint32_t control_header_bytes(void) {
  return align64((uint32_t)sizeof(ControlHeader));
}

static inline uint32_t control_worker_bytes(void) {
  return (uint32_t)(sizeof(Frame) * CONTROL_SLICE_COUNT * CONTROL_MAX_FRAMES);
}

static inline uint32_t control_cont_bytes(void) {
  return (uint32_t)(sizeof(ReifiedCont) * CONTROL_CONT_SLOTS);
}

static inline uint32_t control_susp_bytes(void) {
  return (uint32_t)(sizeof(Suspension) * CONTROL_SUSP_SLOTS);
}

static inline uint32_t total_control_bytes(void) {
  return align64(control_header_bytes() + control_worker_bytes() +
                 control_cont_bytes() + control_susp_bytes());
}

static inline uint64_t pack_freelist_head(uint32_t version, uint32_t index) {
  return ((uint64_t)version << 32) | (uint64_t)index;
}

static inline uint32_t freelist_head_index(uint64_t head) {
  return (uint32_t)(head & 0xffffffffu);
}

static inline uint32_t freelist_head_version(uint64_t head) {
  return (uint32_t)(head >> 32);
}

#if defined(NDEBUG)
#define CONTROL_DEBUG_POISON 0
#else
#define CONTROL_DEBUG_POISON 1
#endif

#if defined(ARENA_DEBUG_TRAP_ON_CONTROL_PTR) && ARENA_DEBUG_TRAP_ON_CONTROL_PTR
#define CONTROL_DEBUG_TRAP_ON_VALUE_ACCESSOR 1
#else
#define CONTROL_DEBUG_TRAP_ON_VALUE_ACCESSOR 0
#endif

static inline void trap_invariant(void) {
#ifdef __wasm__
  __builtin_trap();
#else
  abort();
#endif
}

#ifdef NDEBUG
#define ARENA_ASSERT(x) (void)(x)
#else
#define ARENA_ASSERT(x)                                                        \
  do {                                                                         \
    if (!(x))                                                                  \
      trap_invariant();                                                        \
  } while (0)
#endif

/**
 * Memory ordering helpers: Publication Gate Model.
 * Load 'kind' with acquire to establish publication, then load payload relaxed.
 */
static inline uint8_t load_kind_pub(atomic_uchar *kinds, uint32_t n) {
  return atomic_load_explicit(&kinds[n], memory_order_acquire);
}

static inline uint32_t load_u32_payload(atomic_uint *arr, uint32_t n) {
  return atomic_load_explicit(&arr[n], memory_order_relaxed);
}

static inline uint32_t load_u32_link(atomic_uint *arr, uint32_t n) {
  return atomic_load_explicit(&arr[n], memory_order_acquire);
}

static inline uint8_t load_u8_payload(atomic_uchar *arr, uint32_t n) {
  return atomic_load_explicit(&arr[n], memory_order_relaxed);
}

static inline atomic_uint *link_table_from_header(SabHeader *h) {
  return (atomic_uint *)(ARENA_BASE_ADDR + h->offset_node_link);
}

/** Debug-only structural invariant checks. */
static inline void debug_check_child_ptr(uint32_t v) {
#ifndef NDEBUG
  if (v != EMPTY && is_control_ptr(v))
    trap_invariant();
#else
  (void)v;
#endif
}

static inline bool control_ptr_value_accessor_violation(uint32_t ptr) {
  if (!is_control_ptr(ptr))
    return false;
#if CONTROL_DEBUG_TRAP_ON_VALUE_ACCESSOR
  trap_invariant();
#endif
  return true;
}

static inline ControlViews control_views_from_header(SabHeader *h) {
  ControlViews v;
  uint8_t *base = ARENA_BASE_ADDR + h->offset_control;
  v.header = (ControlHeader *)base;
  base += control_header_bytes();
  v.worker_frames = (Frame *)base;
  base += control_worker_bytes();
  v.conts = (ReifiedCont *)base;
  base += control_cont_bytes();
  v.suspensions = (Suspension *)base;
  return v;
}

static inline ControlViews control_views(void) {
  return control_views_from_header((SabHeader *)ARENA_BASE_ADDR);
}

/** Order: term_cache -> nodes -> buckets. Nodes never move on grow(). Uses
 * 64-bit for offset_buckets/total_size to avoid overflow at large capacity. */
static SabLayout calculate_layout(uint32_t capacity, uint32_t max_capacity) {
  SabLayout l;
  uint32_t reserve_capacity = max_capacity;
  if (reserve_capacity < capacity)
    reserve_capacity = capacity;
  if (reserve_capacity > MAX_CAP)
    reserve_capacity = MAX_CAP;
  l.offset_sq = align64(sizeof(SabHeader));
  l.offset_cq = align64(l.offset_sq + ring_bytes(RING_ENTRIES, sizeof(Sqe)));
  l.offset_stdin = align64(l.offset_cq + ring_bytes(RING_ENTRIES, sizeof(Cqe)));
  l.offset_stdout = align64(l.offset_stdin + ring_bytes(RING_ENTRIES, 1));
  l.offset_stdin_wait = align64(l.offset_stdout + ring_bytes(RING_ENTRIES, 1));
  l.offset_stdout_wait =
      align64(l.offset_stdin_wait + ring_bytes(RING_ENTRIES, 4));
  l.offset_control =
      align64(l.offset_stdout_wait + ring_bytes(RING_ENTRIES, 4));
  l.control_bytes = total_control_bytes();
  l.offset_term_cache = align64(l.offset_control + l.control_bytes);
  /* Invariant offsets: partition the reserved max-capacity space immediately. */
  l.offset_node_left =
      (uint64_t)align64(l.offset_term_cache + TERM_CACHE_LEN * 4);
  l.offset_node_right =
      align64_u64(l.offset_node_left + (uint64_t)reserve_capacity * 4);
  l.offset_node_hash32 =
      align64_u64(l.offset_node_right + (uint64_t)reserve_capacity * 4);
  l.offset_node_next_idx =
      align64_u64(l.offset_node_hash32 + (uint64_t)reserve_capacity * 4);
  l.offset_node_link =
      align64_u64(l.offset_node_next_idx + (uint64_t)reserve_capacity * 4);
  l.offset_node_kind =
      align64_u64(l.offset_node_link + (uint64_t)reserve_capacity * 4);
  l.offset_node_sym =
      align64_u64(l.offset_node_kind + (uint64_t)reserve_capacity * 1);
  /* Buckets follow the node arrays. */
  l.offset_buckets =
      align64_u64(l.offset_node_sym + (uint64_t)reserve_capacity * 1);
  l.total_size = l.offset_buckets + (uint64_t)capacity * 4;
  return l;
}

static void control_init_at(SabHeader *h) {
  ControlViews cv = control_views_from_header(h);
  memset(cv.header, 0, h->control_bytes);
  atomic_init(&cv.header->cont_head, pack_freelist_head(0, CONTROL_CONT_BASE));
  atomic_init(&cv.header->susp_head, pack_freelist_head(0, CONTROL_SUSP_BASE));
  atomic_init(&cv.header->cont_in_use, 0);
  atomic_init(&cv.header->cont_high_water, 0);
  atomic_init(&cv.header->susp_in_use, 0);
  atomic_init(&cv.header->susp_high_water, 0);
  atomic_init(&cv.header->cooperative_retries, 0);
  atomic_init(&cv.header->park_count, 0);
  atomic_init(&cv.header->resume_count, 0);
  for (uint32_t i = 0; i < CONTROL_SLICE_COUNT; i++)
    atomic_init(&cv.header->worker_high_water[i], 0);

  for (uint32_t i = 0; i < CONTROL_CONT_SLOTS; i++) {
    cv.conts[i].flags = 0;
    cv.conts[i].next_free = (i + 1 < CONTROL_CONT_SLOTS)
                                ? (CONTROL_CONT_BASE + i + 1)
                                : CONTROL_INVALID_INDEX;
  }
  for (uint32_t i = 0; i < CONTROL_SUSP_SLOTS; i++) {
    cv.suspensions[i].flags = 0;
    atomic_init(&cv.suspensions[i].status, SUSP_STATUS_FREE);
    cv.suspensions[i].next_free = (i + 1 < CONTROL_SUSP_SLOTS)
                                      ? (CONTROL_SUSP_BASE + i + 1)
                                      : CONTROL_INVALID_INDEX;
  }
}

static uint64_t active_layout_bytes(const SabLayout *layout,
                                    uint32_t capacity) {
  return layout->offset_node_left +
         (uint64_t)capacity * ACTIVE_LAYOUT_BYTES_PER_CAPACITY_SLOT;
}

#ifndef __wasm__
static bool commit_arena_range(uint64_t offset, uint64_t bytes) {
  if (bytes == 0)
    return true;
  if (offset > (uint64_t)SIZE_MAX || bytes > (uint64_t)SIZE_MAX ||
      offset + bytes > (uint64_t)SIZE_MAX) {
    return false;
  }
  return host_commit_memory_range(ARENA_BASE_ADDR, (size_t)offset,
                                  (size_t)bytes);
}

static bool commit_arena_capacity_ranges(const SabLayout *layout,
                                         uint32_t start_index,
                                         uint32_t end_index,
                                         bool include_prefix) {
  uint64_t count = (end_index > start_index) ? (uint64_t)(end_index - start_index)
                                             : 0;
  if (include_prefix &&
      !commit_arena_range(0, (uint64_t)layout->offset_node_left)) {
    return false;
  }
  if (count == 0)
    return true;

  uint64_t start = (uint64_t)start_index;
  if (!commit_arena_range(layout->offset_node_left + start * 4u, count * 4u))
    return false;
  if (!commit_arena_range(layout->offset_node_right + start * 4u, count * 4u))
    return false;
  if (!commit_arena_range(layout->offset_node_hash32 + start * 4u, count * 4u))
    return false;
  if (!commit_arena_range(layout->offset_node_next_idx + start * 4u,
                          count * 4u))
    return false;
  if (!commit_arena_range(layout->offset_node_link + start * 4u, count * 4u))
    return false;
  if (!commit_arena_range(layout->offset_node_kind + start, count))
    return false;
  if (!commit_arena_range(layout->offset_node_sym + start, count))
    return false;
  if (!commit_arena_range(layout->offset_buckets + start * 4u, count * 4u))
    return false;
  return true;
}
#endif

static void *allocate_raw_arena(uint32_t initial_capacity,
                                uint32_t max_capacity) {
  SabLayout layout = calculate_layout(initial_capacity, max_capacity);
#ifdef __wasm__
  uint32_t pages_needed =
      (uint32_t)((layout.total_size + WASM_PAGE_SIZE - 1) / WASM_PAGE_SIZE);
  int old_pages = __builtin_wasm_memory_grow(0, pages_needed);
  if (old_pages == -1)
    return NULL;
  ARENA_BASE_ADDR = (uint8_t *)((uintptr_t)old_pages * WASM_PAGE_SIZE);
#else

  SabLayout reserve_layout = calculate_layout(max_capacity, max_capacity);
  ARENA_RESERVED_BYTES = (size_t)reserve_layout.total_size;
  fprintf(stderr,
          "Arena: reserving %zu bytes (active=%zu initial=%u max=%u), "
          "sizeof(SabHeader)=%zu\n",
          ARENA_RESERVED_BYTES, (size_t)active_layout_bytes(&layout, initial_capacity),
          initial_capacity, max_capacity,
          sizeof(SabHeader));
  ARENA_BASE_ADDR = (uint8_t *)host_reserve_memory(ARENA_RESERVED_BYTES);
  if (ARENA_BASE_ADDR == NULL) {
    fprintf(stderr, "Arena: reserve failed\n");
    return NULL;
  }
  if (!commit_arena_capacity_ranges(&layout, 0, initial_capacity, true)) {
    fprintf(stderr, "Arena: initial commit failed\n");
    host_release_memory(ARENA_BASE_ADDR, ARENA_RESERVED_BYTES);
    ARENA_BASE_ADDR = NULL;
    return NULL;
  }
#endif

  SabHeader *h = (SabHeader *)ARENA_BASE_ADDR;
  h->magic = ARENA_MAGIC;
  h->ring_entries = RING_ENTRIES;
  h->ring_mask = RING_ENTRIES - 1;
  h->offset_sq = layout.offset_sq;
  h->offset_cq = layout.offset_cq;
  h->offset_stdin = layout.offset_stdin;
  h->offset_stdout = layout.offset_stdout;
  h->offset_stdin_wait = layout.offset_stdin_wait;
  h->offset_stdout_wait = layout.offset_stdout_wait;
  h->offset_control = layout.offset_control;
  h->control_bytes = layout.control_bytes;
  h->offset_term_cache = layout.offset_term_cache;
  h->offset_node_left = layout.offset_node_left;
  h->offset_node_right = layout.offset_node_right;
  h->offset_node_hash32 = layout.offset_node_hash32;
  h->offset_node_next_idx = layout.offset_node_next_idx;
  h->offset_node_link = layout.offset_node_link;
  h->offset_node_kind = layout.offset_node_kind;
  h->offset_node_sym = layout.offset_node_sym;
  h->offset_buckets = layout.offset_buckets;
  h->max_capacity = max_capacity;

  /* Layout sanity assertions. */
  ARENA_ASSERT(h->offset_node_left < h->offset_node_right);
  ARENA_ASSERT(h->offset_node_right < h->offset_node_hash32);
  ARENA_ASSERT(h->offset_node_hash32 < h->offset_node_next_idx);
  ARENA_ASSERT(h->offset_node_next_idx < h->offset_node_link);
  ARENA_ASSERT(h->offset_node_link < h->offset_node_kind);
  ARENA_ASSERT(h->offset_node_kind < h->offset_node_sym);
  ARENA_ASSERT(h->offset_node_sym < h->offset_buckets);
#ifndef __wasm__
  if (ARENA_RESERVED_BYTES > 0) {
    ARENA_ASSERT(layout.total_size <= ARENA_RESERVED_BYTES);
  }
#endif

  atomic_init(&h->capacity, initial_capacity);
  h->bucket_mask = initial_capacity - 1;
  atomic_init(&h->resize_seq, 0);
  atomic_init(&h->top, 0);

  ring_init_at(ARENA_BASE_ADDR + h->offset_sq, RING_ENTRIES, sizeof(Sqe));
  ring_init_at(ARENA_BASE_ADDR + h->offset_cq, RING_ENTRIES, sizeof(Cqe));
  ring_init_at(ARENA_BASE_ADDR + h->offset_stdin, RING_ENTRIES, 1);
  ring_init_at(ARENA_BASE_ADDR + h->offset_stdout, RING_ENTRIES, 1);
  ring_init_at(ARENA_BASE_ADDR + h->offset_stdin_wait, RING_ENTRIES, 4);
  ring_init_at(ARENA_BASE_ADDR + h->offset_stdout_wait, RING_ENTRIES, 4);
  control_init_at(h);

  atomic_uint *cache = (atomic_uint *)(ARENA_BASE_ADDR + h->offset_term_cache);
  for (uint32_t i = 0; i < TERM_CACHE_LEN; i++)
    atomic_init(&cache[i], EMPTY);

  memset(ARENA_BASE_ADDR + h->offset_node_left, 0, initial_capacity * 4);
  memset(ARENA_BASE_ADDR + h->offset_node_right, 0, initial_capacity * 4);
  memset(ARENA_BASE_ADDR + h->offset_node_hash32, 0, initial_capacity * 4);
  memset(ARENA_BASE_ADDR + h->offset_node_next_idx, 0, initial_capacity * 4);
  memset(ARENA_BASE_ADDR + h->offset_node_link, 0xff, initial_capacity * 4);
  memset(ARENA_BASE_ADDR + h->offset_node_kind, 0, initial_capacity * 1);
  memset(ARENA_BASE_ADDR + h->offset_node_sym, 0, initial_capacity * 1);

  atomic_uint *buckets = (atomic_uint *)(ARENA_BASE_ADDR + h->offset_buckets);
  for (uint32_t i = 0; i < initial_capacity; i++)
    atomic_init(&buckets[i], EMPTY);

  for (uint32_t u = 0; u < 256; u++)
    atomic_init(&h->u8_cache[u], EMPTY);

  atomic_init(&h->total_nodes, 0);
  atomic_init(&h->total_steps, 0);
  atomic_init(&h->total_link_chase_hops, 0);
  atomic_init(&h->total_cons_allocs, 0);
  atomic_init(&h->total_cont_allocs, 0);
  atomic_init(&h->total_susp_allocs, 0);
  atomic_init(&h->duplicate_lost_allocs, 0);
  atomic_init(&h->hashcons_hits, 0);
  atomic_init(&h->hashcons_misses, 0);

  h->abi_version = SAB_ABI_VERSION;
  h->layout_hash = SAB_LAYOUT_HASH;

  atomic_init(&h->global_epoch, 1);
  for (uint32_t i = 0; i < MAX_WORKERS; i++)
    atomic_init(&h->worker_epochs[i], 0);
  atomic_init(&h->grow_count, 0);
  h->true_id = EMPTY;
  h->false_id = EMPTY;

  return ARENA_BASE_ADDR;
}

static inline void ensure_arena(void) {
  if (ARENA_BASE_ADDR != NULL)
    return;
  if (ARENA_MODE == 1) {
#ifdef __wasm__
    __builtin_trap();
#else
    abort();
#endif
  }
  allocate_raw_arena(INITIAL_CAP, MAX_CAP);
  ARENA_MODE = 0;
}

uint32_t initArena(uint32_t initial_capacity) {
  if (initial_capacity < 1024 || initial_capacity > MAX_CAP ||
      (initial_capacity & (initial_capacity - 1)) != 0) {
    return 0;
  }
  if (ARENA_BASE_ADDR != NULL) {
#ifdef __wasm__
    return (uint32_t)(uintptr_t)ARENA_BASE_ADDR;
#else
    uint32_t addr32 = (uint32_t)(uintptr_t)ARENA_BASE_ADDR;
    return addr32 > 2 ? addr32 : 3;
#endif
  }

  {
    uint32_t starting_capacity =
        (initial_capacity < INITIAL_CAP) ? initial_capacity : INITIAL_CAP;
    if (!allocate_raw_arena(starting_capacity, initial_capacity))
      return 0;
  }

  ARENA_MODE = 1;

  /* Eagerly initialize core constants */
  SabHeader *h = (SabHeader *)ARENA_BASE_ADDR;
  h->true_id = allocTerminal(ARENA_SYM_K);
  uint32_t k = h->true_id;
  uint32_t i = allocTerminal(ARENA_SYM_I);
  h->false_id = allocCons(k, i);

#ifdef __wasm__
  return (uint32_t)(uintptr_t)ARENA_BASE_ADDR;
#else
  uint32_t addr32 = (uint32_t)(uintptr_t)ARENA_BASE_ADDR;
  return addr32 > 2 ? addr32 : 3;
#endif
}

uint32_t connectArena(uint32_t ptr_addr) {
  if (ptr_addr == 0 || ptr_addr % 64 != 0)
    return 0;
  ARENA_BASE_ADDR = (uint8_t *)(uintptr_t)ptr_addr;
  ARENA_MODE = 1;
  SabHeader *h = (SabHeader *)ARENA_BASE_ADDR;
  if (h->magic != ARENA_MAGIC)
    return 5;
  if (h->abi_version != SAB_ABI_VERSION)
    return 6;
  if (h->layout_hash != SAB_LAYOUT_HASH)
    return 7;
  return 1;
}

uint32_t arena_max_capacity(void) { return MAX_CAP; }

void reset(void) {
  ensure_arena();
  SabHeader *h = (SabHeader *)ARENA_BASE_ADDR;
  uint32_t capacity = atomic_load_explicit(&h->capacity, memory_order_relaxed);
  atomic_store_explicit(&h->top, 0, memory_order_release);
  atomic_uint *buckets = (atomic_uint *)(ARENA_BASE_ADDR + h->offset_buckets);
  for (uint32_t i = 0; i < capacity; i++)
    atomic_store_explicit(&buckets[i], EMPTY, memory_order_release);
  atomic_uint *links = link_table_from_header(h);
  for (uint32_t i = 0; i < capacity; i++)
    atomic_store_explicit(&links[i], EMPTY, memory_order_release);
  atomic_uint *cache = (atomic_uint *)(ARENA_BASE_ADDR + h->offset_term_cache);
  for (uint32_t i = 0; i < TERM_CACHE_LEN; i++)
    atomic_store_explicit(&cache[i], EMPTY, memory_order_release);
  control_init_at(h);
  atomic_store_explicit(&h->grow_count, 0, memory_order_release);
  h->true_id = EMPTY;
  h->false_id = EMPTY;
  for (uint32_t u = 0; u < 256; u++)
    atomic_store_explicit(&h->u8_cache[u], EMPTY, memory_order_release);

  atomic_store_explicit(&h->total_nodes, 0, memory_order_release);
  atomic_store_explicit(&h->total_steps, 0, memory_order_release);
  atomic_store_explicit(&h->total_link_chase_hops, 0, memory_order_release);
  atomic_store_explicit(&h->total_cons_allocs, 0, memory_order_release);
  atomic_store_explicit(&h->total_cont_allocs, 0, memory_order_release);
  atomic_store_explicit(&h->total_susp_allocs, 0, memory_order_release);
  atomic_store_explicit(&h->duplicate_lost_allocs, 0, memory_order_release);
  atomic_store_explicit(&h->hashcons_hits, 0, memory_order_release);
  atomic_store_explicit(&h->hashcons_misses, 0, memory_order_release);

  /* Eagerly initialize core constants */
  h->true_id = allocTerminal(ARENA_SYM_K);
  uint32_t k = h->true_id;
  uint32_t i = allocTerminal(ARENA_SYM_I);
  h->false_id = allocCons(k, i);

  atomic_store_explicit(
      &h->resize_seq,
      atomic_load_explicit(&h->resize_seq, memory_order_relaxed) & ~1,
      memory_order_release);
}

static inline uint32_t enter_stable(SabHeader **h_out) {
  SabHeader *h = (SabHeader *)ARENA_BASE_ADDR;
  *h_out = h;
  while (true) {
    uint32_t seq = atomic_load_explicit(&h->resize_seq, memory_order_acquire);
    if (seq == POISON_SEQ) {
#ifdef __wasm__
      __builtin_trap();
#else
      abort();
#endif
    }

    if (seq & 1) {
      /* DEADLOCK FIX: Drop QSBR registration while spinning on the seqlock.
         Otherwise, the thread holding the lock (running grow) will wait
         forever for us to reach a quiescent state. */
      bool is_worker = (tls_worker_id < MAX_WORKERS);
      if (is_worker) {
        atomic_store_explicit(&h->worker_epochs[tls_worker_id], 0,
                              memory_order_release);
      }

      /* Spin until the resize finishes */
      while ((atomic_load_explicit(&h->resize_seq, memory_order_acquire) & 1)) {
#if defined(__linux__) && !defined(__wasm__)
        __builtin_ia32_pause();
#elif defined(__x86_64__) || defined(_M_X64)
        __builtin_ia32_pause();
#else
        (void)0;
#endif
      }

      /* Re-register with the new global epoch before continuing */
      if (is_worker) {
        uint32_t cur_epoch =
            atomic_load_explicit(&h->global_epoch, memory_order_acquire);
        atomic_store_explicit(&h->worker_epochs[tls_worker_id], cur_epoch,
                              memory_order_release);
      }
      continue;
    }

    return seq;
  }
}

static inline bool check_stable(uint32_t seq) {
  SabHeader *h = (SabHeader *)ARENA_BASE_ADDR;
  return atomic_load_explicit(&h->resize_seq, memory_order_acquire) == seq;
}

static inline uint8_t load_head_summary_pub(atomic_uchar *kinds,
                                            atomic_uchar *syms,
                                            uint32_t node_id) {
  if (node_id >= MAX_CAP || is_control_ptr(node_id))
    return IMMEDIATE_HEAD_NONE;

  uint8_t kind = load_kind_pub(kinds, node_id);
  if (kind == ARENA_KIND_NON_TERM)
    return load_u8_payload(syms, node_id);

  return immediate_head_summary_for_leaf_kind(kind);
}

/** Wait-free: nodes never move in memory on grow(). */
uint32_t kindOf(uint32_t n) {
  ensure_arena();
  if (control_ptr_value_accessor_violation(n))
    return 0;
  SabHeader *h = (SabHeader *)ARENA_BASE_ADDR;
  if (n >= atomic_load_explicit(&h->capacity, memory_order_relaxed))
    return 0;
  atomic_uchar *kinds = (atomic_uchar *)(ARENA_BASE_ADDR + h->offset_node_kind);
  return load_kind_pub(kinds, n);
}

uint32_t symOf(uint32_t n) {
  ensure_arena();
  if (control_ptr_value_accessor_violation(n))
    return 0;
  SabHeader *h = (SabHeader *)ARENA_BASE_ADDR;
  if (n >= atomic_load_explicit(&h->capacity, memory_order_relaxed))
    return 0;
  atomic_uchar *syms = (atomic_uchar *)(ARENA_BASE_ADDR + h->offset_node_sym);
  return atomic_load_explicit(&syms[n], memory_order_acquire);
}

uint32_t hashOf(uint32_t n) {
  ensure_arena();
  if (control_ptr_value_accessor_violation(n))
    return 0;
  SabHeader *h = (SabHeader *)ARENA_BASE_ADDR;
  if (n >= atomic_load_explicit(&h->capacity, memory_order_relaxed))
    return 0;
  atomic_uint *hashes =
      (atomic_uint *)(ARENA_BASE_ADDR + h->offset_node_hash32);
  return atomic_load_explicit(&hashes[n], memory_order_acquire);
}

uint32_t leftOf(uint32_t n) {
  ensure_arena();
  if (control_ptr_value_accessor_violation(n))
    return 0;
  SabHeader *h = (SabHeader *)ARENA_BASE_ADDR;
  if (n >= atomic_load_explicit(&h->capacity, memory_order_relaxed))
    return 0;
  atomic_uint *lefts = (atomic_uint *)(ARENA_BASE_ADDR + h->offset_node_left);
  return atomic_load_explicit(&lefts[n], memory_order_acquire);
}

uint32_t rightOf(uint32_t n) {
  ensure_arena();
  if (control_ptr_value_accessor_violation(n))
    return 0;
  SabHeader *h = (SabHeader *)ARENA_BASE_ADDR;
  if (n >= atomic_load_explicit(&h->capacity, memory_order_relaxed))
    return 0;
  atomic_uint *rights = (atomic_uint *)(ARENA_BASE_ADDR + h->offset_node_right);
  return atomic_load_explicit(&rights[n], memory_order_acquire);
}

uint32_t arena_top(void) {
  if (ARENA_BASE_ADDR == NULL)
    return 0;
  SabHeader *h = (SabHeader *)ARENA_BASE_ADDR;
  return atomic_load_explicit(&h->top, memory_order_relaxed);
}

uint32_t arena_capacity(void) {
  if (ARENA_BASE_ADDR == NULL)
    return 0;
  SabHeader *h = (SabHeader *)ARENA_BASE_ADDR;
  return atomic_load_explicit(&h->capacity, memory_order_relaxed);
}

unsigned long long arena_total_nodes(void) {
  if (ARENA_BASE_ADDR == NULL)
    return 0;
  SabHeader *h = (SabHeader *)ARENA_BASE_ADDR;
  return atomic_load_explicit(&h->total_nodes, memory_order_relaxed);
}

unsigned long long arena_total_steps(void) {
  if (ARENA_BASE_ADDR == NULL)
    return 0;
  SabHeader *h = (SabHeader *)ARENA_BASE_ADDR;
  return atomic_load_explicit(&h->total_steps, memory_order_relaxed);
}

unsigned long long arena_total_link_chase_hops(void) {
  if (ARENA_BASE_ADDR == NULL)
    return 0;
  SabHeader *h = (SabHeader *)ARENA_BASE_ADDR;
  return atomic_load_explicit(&h->total_link_chase_hops,
                              memory_order_relaxed);
}

unsigned long long arena_total_cons_allocs(void) {
  if (ARENA_BASE_ADDR == NULL)
    return 0;
  SabHeader *h = (SabHeader *)ARENA_BASE_ADDR;
  return atomic_load_explicit(&h->total_cons_allocs, memory_order_relaxed);
}

unsigned long long arena_total_cont_allocs(void) {
  if (ARENA_BASE_ADDR == NULL)
    return 0;
  SabHeader *h = (SabHeader *)ARENA_BASE_ADDR;
  return atomic_load_explicit(&h->total_cont_allocs, memory_order_relaxed);
}

unsigned long long arena_total_susp_allocs(void) {
  if (ARENA_BASE_ADDR == NULL)
    return 0;
  SabHeader *h = (SabHeader *)ARENA_BASE_ADDR;
  return atomic_load_explicit(&h->total_susp_allocs, memory_order_relaxed);
}

unsigned long long arena_duplicate_lost_allocs(void) {
  if (ARENA_BASE_ADDR == NULL)
    return 0;
  SabHeader *h = (SabHeader *)ARENA_BASE_ADDR;
  return atomic_load_explicit(&h->duplicate_lost_allocs, memory_order_relaxed);
}

unsigned long long arena_hashcons_hits(void) {
  if (ARENA_BASE_ADDR == NULL)
    return 0;
  SabHeader *h = (SabHeader *)ARENA_BASE_ADDR;
  return atomic_load_explicit(&h->hashcons_hits, memory_order_relaxed);
}

unsigned long long arena_hashcons_misses(void) {
  if (ARENA_BASE_ADDR == NULL)
    return 0;
  SabHeader *h = (SabHeader *)ARENA_BASE_ADDR;
  return atomic_load_explicit(&h->hashcons_misses, memory_order_relaxed);
}

void arena_hash_table_stats(unsigned long long *out_items,
                            unsigned long long *out_used_buckets,
                            unsigned long long *out_chain_sq_sum,
                            uint32_t *out_max_chain) {
  unsigned long long items = 0;
  unsigned long long used_buckets = 0;
  unsigned long long chain_sq_sum = 0;
  uint32_t max_chain = 0;

  if (ARENA_BASE_ADDR != NULL) {
    SabHeader *h = (SabHeader *)ARENA_BASE_ADDR;
    while (true) {
      uint32_t seq = enter_stable(&h);
      uint32_t cap = atomic_load_explicit(&h->capacity, memory_order_acquire);
      atomic_uint *buckets =
          (atomic_uint *)(ARENA_BASE_ADDR + h->offset_buckets);
      atomic_uint *next_idxs =
          (atomic_uint *)(ARENA_BASE_ADDR + h->offset_node_next_idx);
      atomic_uchar *kinds =
          (atomic_uchar *)(ARENA_BASE_ADDR + h->offset_node_kind);
      unsigned long long local_items = 0;
      unsigned long long local_used_buckets = 0;
      unsigned long long local_chain_sq_sum = 0;
      uint32_t local_max_chain = 0;

      for (uint32_t b = 0; b < cap; b++) {
        uint32_t chain = 0;
        uint32_t cur = atomic_load_explicit(&buckets[b], memory_order_acquire);

        while (cur != EMPTY && cur < cap) {
          if (chain == cap)
            break;
          if (load_kind_pub(kinds, cur) != ARENA_KIND_NON_TERM)
            break;
          chain++;
          cur = atomic_load_explicit(&next_idxs[cur], memory_order_acquire);
        }

        if (chain == 0)
          continue;

        local_items += chain;
        local_used_buckets++;
        local_chain_sq_sum +=
            (unsigned long long)chain * (unsigned long long)chain;
        if (chain > local_max_chain)
          local_max_chain = chain;
      }

      if (check_stable(seq)) {
        items = local_items;
        used_buckets = local_used_buckets;
        chain_sq_sum = local_chain_sq_sum;
        max_chain = local_max_chain;
        break;
      }
    }
  }

  if (out_items)
    *out_items = items;
  if (out_used_buckets)
    *out_used_buckets = used_buckets;
  if (out_chain_sq_sum)
    *out_chain_sq_sum = chain_sq_sum;
  if (out_max_chain)
    *out_max_chain = max_chain;
}

static void grow(void);

/* Node publication: write all payload fields first (relaxed), then store kind
 * with release so readers that load kind with acquire see initialized data.
 * Uses seqlock (enter_stable/check_stable) for optimistic writes: if grow()
 * happens during our writes, we retry. */
uint32_t allocTerminal(uint32_t sym) {
  ensure_arena();

  while (true) {
    SabHeader *h;
    uint32_t seq = enter_stable(&h);
    atomic_uint *cache =
        (atomic_uint *)(ARENA_BASE_ADDR + h->offset_term_cache);

    if (sym < TERM_CACHE_LEN) {
      uint32_t cached = atomic_load_explicit(&cache[sym], memory_order_acquire);
      if (cached != EMPTY) {
        if (!check_stable(seq))
          continue;
        return cached;
      }
    }

    uint32_t id = atomic_fetch_add_explicit(&h->top, 1, memory_order_acq_rel);
    atomic_fetch_add_explicit(&h->total_nodes, 1, memory_order_relaxed);
    if (id >= atomic_load_explicit(&h->capacity, memory_order_relaxed)) {
      if (tls_worker_id < MAX_WORKERS) {
        atomic_store_explicit(&h->worker_epochs[tls_worker_id], 0,
                              memory_order_release);
        grow();
        uint32_t cur_epoch =
            atomic_load_explicit(&h->global_epoch, memory_order_acquire);
        atomic_store_explicit(&h->worker_epochs[tls_worker_id], cur_epoch,
                              memory_order_release);
      } else {
        grow();
      }
      continue;
    }

    atomic_uchar *kinds =
        (atomic_uchar *)(ARENA_BASE_ADDR + h->offset_node_kind);
    atomic_uchar *syms = (atomic_uchar *)(ARENA_BASE_ADDR + h->offset_node_sym);
    atomic_uint *hashes =
        (atomic_uint *)(ARENA_BASE_ADDR + h->offset_node_hash32);

    atomic_store_explicit(&syms[id], (uint8_t)sym, memory_order_relaxed);
    atomic_store_explicit(&hashes[id], sym, memory_order_relaxed);
    atomic_store_explicit(&kinds[id], ARENA_KIND_TERMINAL,
                          memory_order_release);

    if (sym < TERM_CACHE_LEN) {
      atomic_store_explicit(&cache[sym], id, memory_order_release);
    }

    if (!check_stable(seq))
      continue;

    return id;
  }
}

static uint32_t allocImmediateLeaf(uint8_t kind, uint8_t value) {
  ensure_arena();
  SabHeader *h = (SabHeader *)ARENA_BASE_ADDR;

  while (true) {
    uint32_t seq = enter_stable(&h);

    uint32_t id = atomic_fetch_add_explicit(&h->top, 1, memory_order_acq_rel);
    atomic_fetch_add_explicit(&h->total_nodes, 1, memory_order_relaxed);
    if (id >= atomic_load_explicit(&h->capacity, memory_order_relaxed)) {
      if (tls_worker_id < MAX_WORKERS) {
        atomic_store_explicit(&h->worker_epochs[tls_worker_id], 0,
                              memory_order_release);
        grow();
        uint32_t cur_epoch =
            atomic_load_explicit(&h->global_epoch, memory_order_acquire);
        atomic_store_explicit(&h->worker_epochs[tls_worker_id], cur_epoch,
                              memory_order_release);
      } else {
        grow();
      }
      continue;
    }

    atomic_uint *lefts = (atomic_uint *)(ARENA_BASE_ADDR + h->offset_node_left);
    atomic_uint *rights =
        (atomic_uint *)(ARENA_BASE_ADDR + h->offset_node_right);
    atomic_uint *hashes =
        (atomic_uint *)(ARENA_BASE_ADDR + h->offset_node_hash32);
    atomic_uchar *kinds =
        (atomic_uchar *)(ARENA_BASE_ADDR + h->offset_node_kind);
    atomic_uchar *syms = (atomic_uchar *)(ARENA_BASE_ADDR + h->offset_node_sym);

    atomic_store_explicit(&lefts[id], EMPTY, memory_order_relaxed);
    atomic_store_explicit(&rights[id], EMPTY, memory_order_relaxed);
    atomic_store_explicit(&syms[id], value, memory_order_relaxed);
    atomic_store_explicit(&hashes[id],
                          ((uint32_t)kind << 8) | (uint32_t)value,
                          memory_order_relaxed);
    atomic_store_explicit(&kinds[id], kind, memory_order_release);

    if (!check_stable(seq))
      continue;

    return id;
  }
}

uint32_t allocJ(uint8_t value) { return allocImmediateLeaf(ARENA_KIND_J, value); }

uint32_t allocV(uint8_t value) { return allocImmediateLeaf(ARENA_KIND_V, value); }

uint32_t allocU8(uint8_t value) {
  ensure_arena();
  SabHeader *h = (SabHeader *)ARENA_BASE_ADDR;

  uint32_t cached =
      atomic_load_explicit(&h->u8_cache[value], memory_order_acquire);
  if (cached != EMPTY)
    return cached;

  while (true) {
    uint32_t seq = enter_stable(&h);

    uint32_t id = atomic_fetch_add_explicit(&h->top, 1, memory_order_acq_rel);
    atomic_fetch_add_explicit(&h->total_nodes, 1, memory_order_relaxed);
    if (id >= atomic_load_explicit(&h->capacity, memory_order_relaxed)) {
      if (tls_worker_id < MAX_WORKERS) {
        atomic_store_explicit(&h->worker_epochs[tls_worker_id], 0,
                              memory_order_release);
        grow();
        uint32_t cur_epoch =
            atomic_load_explicit(&h->global_epoch, memory_order_acquire);
        atomic_store_explicit(&h->worker_epochs[tls_worker_id], cur_epoch,
                              memory_order_release);
      } else {
        grow();
      }
      continue;
    }

    atomic_uint *lefts = (atomic_uint *)(ARENA_BASE_ADDR + h->offset_node_left);
    atomic_uint *rights =
        (atomic_uint *)(ARENA_BASE_ADDR + h->offset_node_right);
    atomic_uint *hashes =
        (atomic_uint *)(ARENA_BASE_ADDR + h->offset_node_hash32);
    atomic_uchar *kinds =
        (atomic_uchar *)(ARENA_BASE_ADDR + h->offset_node_kind);
    atomic_uchar *syms = (atomic_uchar *)(ARENA_BASE_ADDR + h->offset_node_sym);

    atomic_store_explicit(&lefts[id], EMPTY, memory_order_relaxed);
    atomic_store_explicit(&rights[id], EMPTY, memory_order_relaxed);
    atomic_store_explicit(&syms[id], value, memory_order_relaxed);
    atomic_store_explicit(&hashes[id], (uint32_t)value, memory_order_relaxed);
    atomic_store_explicit(&kinds[id], ARENA_KIND_U8, memory_order_release);

    if (!check_stable(seq))
      continue;

    uint32_t expected = EMPTY;
    if (atomic_compare_exchange_strong_explicit(&h->u8_cache[value], &expected, id,
                                                memory_order_release,
                                                memory_order_relaxed))
      return id;
    return atomic_load_explicit(&h->u8_cache[value], memory_order_acquire);
  }
}

#ifndef ARENA_HASH_MIX_MODE
#define ARENA_HASH_MIX_MODE 0
#endif

#ifndef ARENA_HASH_BUCKET_MODE
#define ARENA_HASH_BUCKET_MODE 0
#endif

static inline __attribute__((unused)) uint32_t rotl32(uint32_t x, uint32_t r) {
  return (x << r) | (x >> (32 - r));
}

static inline __attribute__((unused)) uint32_t avalanche32(uint32_t x) {
  x ^= x >> 16;
  x *= 0x7feb352d;
  x ^= x >> 15;
  x *= 0x846ca68b;
  x ^= x >> 16;
  return x;
}

static inline __attribute__((unused)) uint32_t fmix32(uint32_t x) {
  x ^= x >> 16;
  x *= 0x85ebca6b;
  x ^= x >> 13;
  x *= 0xc2b2ae35;
  x ^= x >> 16;
  return x;
}

static inline __attribute__((unused)) uint64_t fmix64(uint64_t x) {
  x ^= x >> 33;
  x *= 0xff51afd7ed558ccdULL;
  x ^= x >> 33;
  x *= 0xc4ceb9fe1a85ec53ULL;
  x ^= x >> 33;
  return x;
}

const char *arena_hash_mix_name(void) {
#if ARENA_HASH_MIX_MODE == 0
  return "avalanche-xormul";
#elif ARENA_HASH_MIX_MODE == 1
  return "fmix32-xorrot";
#elif ARENA_HASH_MIX_MODE == 2
  return "fmix64-pair";
#elif ARENA_HASH_MIX_MODE == 3
  return "fnv-stream-fmix32";
#else
#error "Unsupported ARENA_HASH_MIX_MODE"
#endif
}

const char *arena_hash_bucket_name(void) {
#if ARENA_HASH_BUCKET_MODE == 0
  return "mask-lowbits";
#elif ARENA_HASH_BUCKET_MODE == 1
  return "fmix32-mask";
#else
#error "Unsupported ARENA_HASH_BUCKET_MODE"
#endif
}

static inline uint32_t bucket_index(uint32_t hv, uint32_t bucket_mask) {
#if ARENA_HASH_BUCKET_MODE == 0
  return hv & bucket_mask;
#elif ARENA_HASH_BUCKET_MODE == 1
  return fmix32(hv) & bucket_mask;
#else
#error "Unsupported ARENA_HASH_BUCKET_MODE"
#endif
}

static inline uint32_t mix(uint32_t a, uint32_t b) {
#if ARENA_HASH_MIX_MODE == 0
  return avalanche32(a ^ (b * 0x9e3779b9u));
#elif ARENA_HASH_MIX_MODE == 1
  return fmix32(a ^ rotl32(b, 16) ^ 0x9e3779b9u);
#elif ARENA_HASH_MIX_MODE == 2
  uint64_t x = (((uint64_t)a << 32) | (uint64_t)b) ^ 0x9e3779b97f4a7c15ULL;
  x = fmix64(x);
  return (uint32_t)(x ^ (x >> 32));
#elif ARENA_HASH_MIX_MODE == 3
  return fmix32((a * 0x01000193u) ^ b ^ 0x9e3779b9u);
#else
#error "Unsupported ARENA_HASH_MIX_MODE"
#endif
}

uint32_t allocCons(uint32_t l, uint32_t r) {
  ensure_arena();
  SabHeader *h = (SabHeader *)ARENA_BASE_ADDR;
  if (is_control_ptr(l) || is_control_ptr(r))
    trap_invariant();

  /* Wait-free hash reads (nodes never move). */
  uint32_t hl = hashOf(l);
  uint32_t hr = hashOf(r);
  uint32_t hval = mix(hl, hr);

  /* Search existing bucket under seqlock (buckets/capacity change on grow). */
  while (true) {
    uint32_t seq = enter_stable(&h);
    if (l >= atomic_load_explicit(&h->capacity, memory_order_relaxed) ||
        r >= atomic_load_explicit(&h->capacity, memory_order_relaxed))
      return EMPTY;
    atomic_uchar *kinds =
        (atomic_uchar *)(ARENA_BASE_ADDR + h->offset_node_kind);
    atomic_uint *lefts = (atomic_uint *)(ARENA_BASE_ADDR + h->offset_node_left);
    atomic_uint *rights =
        (atomic_uint *)(ARENA_BASE_ADDR + h->offset_node_right);
    atomic_uint *hashes =
        (atomic_uint *)(ARENA_BASE_ADDR + h->offset_node_hash32);
    atomic_uint *next_idxs =
        (atomic_uint *)(ARENA_BASE_ADDR + h->offset_node_next_idx);
    atomic_uint *buckets = (atomic_uint *)(ARENA_BASE_ADDR + h->offset_buckets);
    uint32_t b = bucket_index(hval, h->bucket_mask);

    uint32_t cur = atomic_load_explicit(&buckets[b], memory_order_acquire);
    uint32_t found = EMPTY;

    while (cur != EMPTY &&
           cur < atomic_load_explicit(&h->capacity, memory_order_relaxed)) {
      if (load_kind_pub(kinds, cur) == ARENA_KIND_NON_TERM &&
          load_u32_payload(hashes, cur) == hval &&
          load_u32_payload(lefts, cur) == l &&
          load_u32_payload(rights, cur) == r) {
        found = cur;
        break;
      }
      cur = atomic_load_explicit(&next_idxs[cur], memory_order_acquire);
    }

    if (check_stable(seq)) {
      if (found != EMPTY) {
        atomic_fetch_add_explicit(&h->hashcons_hits, 1, memory_order_relaxed);
        return found;
      }
      break;
    }
  }

  atomic_fetch_add_explicit(&h->total_cons_allocs, 1, memory_order_relaxed);
  atomic_fetch_add_explicit(&h->hashcons_misses, 1, memory_order_relaxed);

  /* Allocate and link into bucket. */
  while (true) {
    uint32_t seq = enter_stable(&h);
    uint32_t b = bucket_index(hval, h->bucket_mask);
    uint32_t id = atomic_fetch_add_explicit(&h->top, 1, memory_order_acq_rel);
    atomic_fetch_add_explicit(&h->total_nodes, 1, memory_order_relaxed);
    if (id >= atomic_load_explicit(&h->capacity, memory_order_relaxed)) {
      if (tls_worker_id < MAX_WORKERS) {
        atomic_store_explicit(&h->worker_epochs[tls_worker_id], 0,
                              memory_order_release);
        grow();
        uint32_t cur_epoch =
            atomic_load_explicit(&h->global_epoch, memory_order_acquire);
        atomic_store_explicit(&h->worker_epochs[tls_worker_id], cur_epoch,
                              memory_order_release);
      } else {
        grow();
      }
      continue;
    }

    atomic_uint *lefts = (atomic_uint *)(ARENA_BASE_ADDR + h->offset_node_left);
    atomic_uint *rights =
        (atomic_uint *)(ARENA_BASE_ADDR + h->offset_node_right);
    atomic_uint *hashes =
        (atomic_uint *)(ARENA_BASE_ADDR + h->offset_node_hash32);
    atomic_uchar *kinds =
        (atomic_uchar *)(ARENA_BASE_ADDR + h->offset_node_kind);
    atomic_uchar *syms = (atomic_uchar *)(ARENA_BASE_ADDR + h->offset_node_sym);
    atomic_uint *next_idxs =
        (atomic_uint *)(ARENA_BASE_ADDR + h->offset_node_next_idx);
    atomic_uint *buckets = (atomic_uint *)(ARENA_BASE_ADDR + h->offset_buckets);
    uint8_t head_summary = load_head_summary_pub(kinds, syms, l);
    if (head_summary == IMMEDIATE_HEAD_NONE)
      head_summary = IMMEDIATE_HEAD_OTHER;

    atomic_store_explicit(&lefts[id], l, memory_order_relaxed);
    atomic_store_explicit(&rights[id], r, memory_order_relaxed);
    atomic_store_explicit(&hashes[id], hval, memory_order_relaxed);
    /* Non-term nodes reuse the sym byte as a cached spine-head summary so the
     * reducer can skip speculative J/V classification on ordinary nodes. */
    atomic_store_explicit(&syms[id], head_summary, memory_order_relaxed);
    atomic_store_explicit(&kinds[id], ARENA_KIND_NON_TERM,
                          memory_order_release);

    if (!check_stable(seq))
      continue;

    while (true) {
      if (!check_stable(seq))
        return id;

      uint32_t head = atomic_load_explicit(&buckets[b], memory_order_acquire);
      atomic_store_explicit(&next_idxs[id], head, memory_order_relaxed);
      if (atomic_compare_exchange_weak_explicit(&buckets[b], &head, id,
                                                memory_order_release,
                                                memory_order_relaxed)) {
        return id;
      }

      /* CAS failed: another thread may have inserted same (l,r); re-scan. */
      uint32_t cur2 = atomic_load_explicit(&buckets[b], memory_order_acquire);
      while (cur2 != EMPTY &&
             cur2 < atomic_load_explicit(&h->capacity, memory_order_relaxed)) {
        if (load_kind_pub(kinds, cur2) == ARENA_KIND_NON_TERM &&
            load_u32_payload(hashes, cur2) == hval &&
            load_u32_payload(lefts, cur2) == l &&
            load_u32_payload(rights, cur2) == r) {
          atomic_store_explicit(&kinds[id], 0, memory_order_release);
          atomic_fetch_add_explicit(&h->duplicate_lost_allocs, 1,
                                    memory_order_relaxed);
          return cur2;
        }
        cur2 = atomic_load_explicit(&next_idxs[cur2], memory_order_acquire);
      }
    }
  }
}

static inline void update_high_water(atomic_uint *slot, uint32_t value) {
  uint32_t current = atomic_load_explicit(slot, memory_order_relaxed);
  while (value > current && !atomic_compare_exchange_weak_explicit(
                                slot, &current, value, memory_order_relaxed,
                                memory_order_relaxed)) {
  }
}

static inline uint32_t control_cont_ptr_from_slot(uint32_t slot) {
  return make_control_ptr(CONTROL_CONT_BASE + slot);
}

static inline uint32_t control_susp_ptr_from_slot(uint32_t slot) {
  return make_control_ptr(CONTROL_SUSP_BASE + slot);
}

static inline bool control_index_is_cont(uint32_t index) {
  return index >= CONTROL_CONT_BASE && index < CONTROL_SUSP_BASE;
}

static inline bool control_index_is_susp(uint32_t index) {
  return index >= CONTROL_SUSP_BASE &&
         index < (CONTROL_SUSP_BASE + CONTROL_SUSP_SLOTS);
}

static inline ReifiedCont *control_cont_from_ptr(ControlViews cv,
                                                 uint32_t ptr) {
  if (!is_control_ptr(ptr))
    return NULL;
  uint32_t index = control_index(ptr);
  if (!control_index_is_cont(index))
    return NULL;
  return &cv.conts[index - CONTROL_CONT_BASE];
}

static inline Suspension *control_susp_from_ptr(ControlViews cv, uint32_t ptr) {
  if (!is_control_ptr(ptr))
    return NULL;
  uint32_t index = control_index(ptr);
  if (!control_index_is_susp(index))
    return NULL;
  return &cv.suspensions[index - CONTROL_SUSP_BASE];
}

static uint32_t control_pop_cont(ControlViews cv) {
  while (true) {
    unsigned long long head =
        atomic_load_explicit(&cv.header->cont_head, memory_order_acquire);
    uint32_t index = freelist_head_index(head);
    if (index == CONTROL_INVALID_INDEX)
      return EMPTY;
    if (!control_index_is_cont(index))
      trap_invariant();
    uint32_t slot = index - CONTROL_CONT_BASE;
    uint32_t next = cv.conts[slot].next_free;
    unsigned long long next_head =
        pack_freelist_head(freelist_head_version(head) + 1, next);
    unsigned long long expected = head;
    if (atomic_compare_exchange_weak_explicit(&cv.header->cont_head, &expected,
                                              next_head, memory_order_acq_rel,
                                              memory_order_acquire)) {
      cv.conts[slot].flags = CONT_FLAG_ALLOCATED;
      cv.conts[slot].next_free = CONTROL_INVALID_INDEX;
      uint32_t in_use = atomic_fetch_add_explicit(&cv.header->cont_in_use, 1,
                                                  memory_order_relaxed) +
                        1;
      update_high_water(&cv.header->cont_high_water, in_use);
      return slot;
    }
  }
}

static inline void worker_reset_state(WorkerState *ws, uint8_t status) {
  ws->current_val = EMPTY;
  ws->sp = 0;
  ws->remaining_steps = 0;
  ws->mode = MODE_DESCEND;
  ws->status = status;
  ws->reserved = 0;
}

static inline void control_poison_cont(ReifiedCont *cont) {
  cont->current_val = EMPTY;
  cont->saved_sp = 0;
  cont->remaining_steps = 0;
  cont->mode = 0;
  cont->reserved = 0;
  cont->next_free = CONTROL_INVALID_INDEX;
#if CONTROL_DEBUG_POISON
  memset(cont->frames, 0xa5, sizeof(cont->frames));
#endif
}

static inline void control_poison_susp(Suspension *susp) {
  susp->reason = 0;
  susp->cont_ptr = 0;
  susp->wait_token = 0;
  susp->next_free = CONTROL_INVALID_INDEX;
}

/* After a successful pop, the slot is exclusively owned until pushed back. */
static uint32_t control_pop_susp(ControlViews cv) {
  while (true) {
    unsigned long long head =
        atomic_load_explicit(&cv.header->susp_head, memory_order_acquire);
    uint32_t index = freelist_head_index(head);
    if (index == CONTROL_INVALID_INDEX)
      return EMPTY;
    if (!control_index_is_susp(index))
      trap_invariant();
    uint32_t slot = index - CONTROL_SUSP_BASE;
    uint32_t next = cv.suspensions[slot].next_free;
    unsigned long long next_head =
        pack_freelist_head(freelist_head_version(head) + 1, next);
    unsigned long long expected = head;
    if (atomic_compare_exchange_weak_explicit(&cv.header->susp_head, &expected,
                                              next_head, memory_order_acq_rel,
                                              memory_order_acquire)) {
      cv.suspensions[slot].flags = SUSP_FLAG_ALLOCATED;
      atomic_store_explicit(&cv.suspensions[slot].status, SUSP_STATUS_CLAIMED,
                            memory_order_relaxed);
      cv.suspensions[slot].next_free = CONTROL_INVALID_INDEX;
      uint32_t in_use = atomic_fetch_add_explicit(&cv.header->susp_in_use, 1,
                                                  memory_order_relaxed) +
                        1;
      update_high_water(&cv.header->susp_high_water, in_use);
      return slot;
    }
  }
}

static void control_push_cont(ControlViews cv, uint32_t slot) {
  if (slot >= CONTROL_CONT_SLOTS || cv.conts[slot].flags != CONT_FLAG_ALLOCATED)
    trap_invariant();
  uint32_t index = CONTROL_CONT_BASE + slot;
  control_poison_cont(&cv.conts[slot]);
  cv.conts[slot].flags = 0;
  while (true) {
    unsigned long long head =
        atomic_load_explicit(&cv.header->cont_head, memory_order_acquire);
    cv.conts[slot].next_free = freelist_head_index(head);
    unsigned long long next_head =
        pack_freelist_head(freelist_head_version(head) + 1, index);
    unsigned long long expected = head;
    if (atomic_compare_exchange_weak_explicit(&cv.header->cont_head, &expected,
                                              next_head, memory_order_acq_rel,
                                              memory_order_acquire)) {
      atomic_fetch_sub_explicit(&cv.header->cont_in_use, 1,
                                memory_order_relaxed);
      return;
    }
  }
}

static void control_push_susp(ControlViews cv, uint32_t slot) {
  if (slot >= CONTROL_SUSP_SLOTS ||
      cv.suspensions[slot].flags != SUSP_FLAG_ALLOCATED)
    trap_invariant();
  if (atomic_load_explicit(&cv.suspensions[slot].status,
                           memory_order_acquire) != SUSP_STATUS_CLAIMED)
    trap_invariant();
  uint32_t index = CONTROL_SUSP_BASE + slot;
  control_poison_susp(&cv.suspensions[slot]);
  cv.suspensions[slot].flags = 0;
  atomic_store_explicit(&cv.suspensions[slot].status, SUSP_STATUS_FREE,
                        memory_order_release);
  while (true) {
    unsigned long long head =
        atomic_load_explicit(&cv.header->susp_head, memory_order_acquire);
    cv.suspensions[slot].next_free = freelist_head_index(head);
    unsigned long long next_head =
        pack_freelist_head(freelist_head_version(head) + 1, index);
    unsigned long long expected = head;
    if (atomic_compare_exchange_weak_explicit(&cv.header->susp_head, &expected,
                                              next_head, memory_order_acq_rel,
                                              memory_order_acquire)) {
      atomic_fetch_sub_explicit(&cv.header->susp_in_use, 1,
                                memory_order_relaxed);
      return;
    }
  }
}

static inline Frame *control_worker_frames(ControlViews cv, uint32_t slice_id) {
  if (slice_id >= CONTROL_SLICE_COUNT)
    trap_invariant();
  return &cv.worker_frames[slice_id * CONTROL_MAX_FRAMES];
}

static inline void worker_track_sp(ControlViews cv, uint32_t slice_id,
                                   uint32_t sp) {
  if (sp > CONTROL_MAX_FRAMES)
    trap_invariant();
  update_high_water(&cv.header->worker_high_water[slice_id], sp);
}

static inline void worker_push_frame(ControlViews cv, uint32_t slice_id,
                                     WorkerState *ws, Frame frame) {
  if (ws->sp >= CONTROL_MAX_FRAMES)
    trap_invariant();
  Frame *frames = control_worker_frames(cv, slice_id);
  frames[ws->sp++] = frame;
  worker_track_sp(cv, slice_id, ws->sp);
}

static inline Frame worker_pop_frame(ControlViews cv, uint32_t slice_id,
                                     WorkerState *ws) {
  if (ws->sp == 0)
    trap_invariant();
  Frame *frames = control_worker_frames(cv, slice_id);
  return frames[--ws->sp];
}

#ifndef __wasm__
static inline uint64_t trace_worker_thread_id(void) {
#if defined(__linux__) && !defined(__wasm__)
  return (uint64_t)syscall(SYS_gettid);
#else
  return 0;
#endif
}

static const char *trace_event_kind_name(uint32_t kind) {
  switch (kind) {
  case TRACE_EV_JOB_START:
    return "job_start";
  case TRACE_EV_JOB_RESUME:
    return "job_resume";
  case TRACE_EV_SAFEPOINT:
    return "safepoint";
  case TRACE_EV_PARK:
    return "park";
  case TRACE_EV_DONE:
    return "done";
  case TRACE_EV_IO_WAIT:
    return "io_wait";
  case TRACE_EV_STEP_LIMIT:
    return "step_limit";
  default:
    return "unknown";
  }
}

static const char *trace_worker_status_name(uint32_t status) {
  switch (status) {
  case WORKER_RUNNING:
    return "running";
  case WORKER_YIELD_RETRY:
    return "yield_retry";
  case WORKER_IDLE:
    return "idle";
  default:
    return "unknown";
  }
}

static const char *trace_mode_name(uint32_t mode) {
  switch (mode) {
  case MODE_DESCEND:
    return "descend";
  case MODE_RETURN:
    return "return";
  default:
    return "unknown";
  }
}

static const char *trace_arena_kind_name(uint32_t kind) {
  switch (kind) {
  case ARENA_KIND_TERMINAL:
    return "terminal";
  case ARENA_KIND_NON_TERM:
    return "app";
  case ARENA_KIND_U8:
    return "u8";
  case ARENA_KIND_J:
    return "j";
  case ARENA_KIND_V:
    return "v";
  default:
    return "unknown";
  }
}

static const char *trace_arena_sym_name(uint32_t sym) {
  switch (sym) {
  case ARENA_SYM_S:
    return "S";
  case ARENA_SYM_K:
    return "K";
  case ARENA_SYM_I:
    return "I";
  case ARENA_SYM_READ_ONE:
    return "READ_ONE";
  case ARENA_SYM_WRITE_ONE:
    return "WRITE_ONE";
  case ARENA_SYM_B:
    return "B";
  case ARENA_SYM_C:
    return "C";
  case ARENA_SYM_SPRIME:
    return "SPRIME";
  case ARENA_SYM_BPRIME:
    return "BPRIME";
  case ARENA_SYM_CPRIME:
    return "CPRIME";
  case ARENA_SYM_EQ_U8:
    return "EQ_U8";
  case ARENA_SYM_LT_U8:
    return "LT_U8";
  case ARENA_SYM_DIV_U8:
    return "DIV_U8";
  case ARENA_SYM_MOD_U8:
    return "MOD_U8";
  case ARENA_SYM_ADD_U8:
    return "ADD_U8";
  case ARENA_SYM_SUB_U8:
    return "SUB_U8";
  default:
    return "UNKNOWN";
  }
}

static inline WorkerTraceState *trace_state_for(uint32_t worker_id) {
  if (worker_id >= MAX_WORKERS)
    return NULL;
  return &WORKER_TRACE[worker_id];
}

static inline void trace_publish_live(uint32_t worker_id, const WorkerState *ws,
                                      uint64_t step_counter) {
  WorkerTraceState *ts = trace_state_for(worker_id);
  if (ts == NULL || ws == NULL)
    return;
  atomic_store_explicit(&ts->live_status, ws->status, memory_order_relaxed);
  atomic_store_explicit(&ts->live_req_id, ws->req_id, memory_order_relaxed);
  atomic_store_explicit(&ts->live_current_val, ws->current_val,
                        memory_order_relaxed);
  atomic_store_explicit(&ts->live_remaining_steps, ws->remaining_steps,
                        memory_order_relaxed);
  atomic_store_explicit(&ts->live_mode, ws->mode, memory_order_relaxed);
  atomic_store_explicit(&ts->live_sp, ws->sp, memory_order_relaxed);
  atomic_store_explicit(&ts->live_thread_id, trace_worker_thread_id(),
                        memory_order_relaxed);
  atomic_store_explicit(&ts->live_step_counter, step_counter,
                        memory_order_relaxed);
}

static inline void trace_record_event(uint32_t worker_id, uint64_t step_counter,
                                      uint32_t req_id, uint32_t kind,
                                      uint32_t a, uint32_t b, uint32_t c) {
  WorkerTraceState *ts = trace_state_for(worker_id);
  if (ts == NULL)
    return;
  uint32_t head = atomic_load_explicit(&ts->ring_head, memory_order_relaxed);
  TraceEvent *ev = &ts->ring[head % TRACE_RING_SIZE];
  ev->step = step_counter;
  ev->kind = kind;
  ev->a = a;
  ev->b = b;
  ev->c = c;
  ev->req_id = req_id;
  atomic_store_explicit(&ts->ring_head, head + 1, memory_order_release);
}

static bool trace_graph_contains(const TraceGraphNode *out, uint32_t count,
                                 uint32_t node_id) {
  for (uint32_t i = 0; i < count; i++) {
    if (out[i].node_id == node_id)
      return true;
  }
  return false;
}

static bool trace_graph_append(TraceGraphNode *out, uint32_t *count,
                               uint32_t node_id) {
  if (node_id == EMPTY || is_control_ptr(node_id) || count == NULL ||
      *count >= TRACE_GRAPH_NODES || trace_graph_contains(out, *count, node_id))
    return false;

  uint32_t cap = arena_capacity();
  if (node_id >= cap)
    return false;

  SabHeader *h = (SabHeader *)ARENA_BASE_ADDR;
  atomic_uchar *kinds = (atomic_uchar *)(ARENA_BASE_ADDR + h->offset_node_kind);
  atomic_uchar *syms = (atomic_uchar *)(ARENA_BASE_ADDR + h->offset_node_sym);
  atomic_uint *lefts = (atomic_uint *)(ARENA_BASE_ADDR + h->offset_node_left);
  atomic_uint *rights = (atomic_uint *)(ARENA_BASE_ADDR + h->offset_node_right);

  TraceGraphNode *node = &out[*count];
  node->node_id = node_id;
  node->kind = load_kind_pub(kinds, node_id);
  node->sym = load_u8_payload(syms, node_id);
  node->left = load_u32_payload(lefts, node_id);
  node->right = load_u32_payload(rights, node_id);
  (*count)++;
  return true;
}

static uint32_t trace_capture_focus_graph(uint32_t focus,
                                          TraceGraphNode *out) {
  if (out == NULL || focus == EMPTY || is_control_ptr(focus))
    return 0;

  uint32_t count = 0;
  uint32_t queue[TRACE_GRAPH_NODES];
  uint32_t qhead = 0;
  uint32_t qtail = 0;

  if (trace_graph_append(out, &count, focus))
    queue[qtail++] = focus;

  uint32_t spine = focus;
  for (uint32_t i = 0; i < TRACE_SPINE_NODES && qtail < TRACE_GRAPH_NODES; i++) {
    uint32_t cap = arena_capacity();
    if (spine == EMPTY || is_control_ptr(spine) || spine >= cap)
      break;
    if (kindOf(spine) != ARENA_KIND_NON_TERM)
      break;
    uint32_t fn = leftOf(spine);
    if (trace_graph_append(out, &count, fn))
      queue[qtail++] = fn;
    spine = fn;
  }

  while (qhead < qtail && count < TRACE_GRAPH_BFS_LIMIT) {
    uint32_t node_id = queue[qhead++];
    uint32_t cap = arena_capacity();
    if (node_id == EMPTY || is_control_ptr(node_id) || node_id >= cap)
      continue;
    if (kindOf(node_id) != ARENA_KIND_NON_TERM)
      continue;
    uint32_t l = leftOf(node_id);
    uint32_t r = rightOf(node_id);
    if (qtail < TRACE_GRAPH_NODES && trace_graph_append(out, &count, l))
      queue[qtail++] = l;
    if (qtail < TRACE_GRAPH_NODES && trace_graph_append(out, &count, r))
      queue[qtail++] = r;
  }

  return count;
}

static uint32_t trace_copy_recent_events(WorkerTraceState *ts,
                                         TraceEvent *out) {
  if (ts == NULL || out == NULL)
    return 0;
  uint32_t head = atomic_load_explicit(&ts->ring_head, memory_order_acquire);
  uint32_t count = head < TRACE_RING_SIZE ? head : TRACE_RING_SIZE;
  uint32_t start = head > TRACE_RING_SIZE ? head - TRACE_RING_SIZE : 0;
  for (uint32_t i = 0; i < count; i++) {
    out[i] = ts->ring[(start + i) % TRACE_RING_SIZE];
  }
  return count;
}

static void trace_capture_snapshot(uint32_t worker_id, const WorkerState *ws,
                                   uint64_t step_counter, uint32_t epoch,
                                   bool live_only) {
  WorkerTraceState *ts = trace_state_for(worker_id);
  if (ts == NULL)
    return;

  WorkerTraceSnapshot *snap = &ts->snapshot;
  memset(snap, 0, sizeof(*snap));
  snap->worker_id = worker_id;

  if (ws != NULL && !live_only) {
    snap->status = ws->status;
    snap->req_id = ws->req_id;
    snap->current_val = ws->current_val;
    snap->remaining_steps = ws->remaining_steps;
    snap->mode = ws->mode;
    snap->control_depth = ws->sp;
    snap->step_counter = step_counter;
    snap->thread_id = trace_worker_thread_id();

    uint32_t base = (ws->sp > TRACE_STACK_SNAPSHOT) ? (ws->sp - TRACE_STACK_SNAPSHOT) : 0;
    uint32_t count = ws->sp - base;
    snap->control_base = base;
    snap->control_count = count;
    if (count > 0) {
      memcpy(snap->control_stack, control_worker_frames(control_views(), worker_id) + base,
             count * sizeof(Frame));
    }
  } else {
    snap->status = atomic_load_explicit(&ts->live_status, memory_order_acquire);
    snap->req_id = atomic_load_explicit(&ts->live_req_id, memory_order_acquire);
    snap->current_val = atomic_load_explicit(&ts->live_current_val, memory_order_acquire);
    snap->remaining_steps =
        atomic_load_explicit(&ts->live_remaining_steps, memory_order_acquire);
    snap->mode = atomic_load_explicit(&ts->live_mode, memory_order_acquire);
    snap->control_depth = atomic_load_explicit(&ts->live_sp, memory_order_acquire);
    snap->step_counter = atomic_load_explicit(&ts->live_step_counter, memory_order_acquire);
    snap->thread_id = atomic_load_explicit(&ts->live_thread_id, memory_order_acquire);
    snap->control_base = 0;
    snap->control_count = 0;
  }

  snap->event_count = trace_copy_recent_events(ts, snap->recent_events);
  snap->graph_count = trace_capture_focus_graph(snap->current_val, snap->focus_graph);

  atomic_store_explicit(&ts->last_seen_epoch, epoch, memory_order_relaxed);
  atomic_store_explicit(&ts->snapshot_epoch_done, epoch, memory_order_release);
}

static inline void trace_maybe_snapshot(uint32_t worker_id, WorkerState *ws,
                                        uint64_t step_counter) {
  WorkerTraceState *ts = trace_state_for(worker_id);
  if (ts == NULL || ws == NULL)
    return;
  trace_publish_live(worker_id, ws, step_counter);
  uint32_t epoch = atomic_load_explicit(&TRACE_REQUESTED_EPOCH, memory_order_acquire);
  if (epoch == 0)
    return;
  uint32_t seen = atomic_load_explicit(&ts->last_seen_epoch, memory_order_acquire);
  if (epoch == seen)
    return;
  trace_record_event(worker_id, step_counter, ws->req_id, TRACE_EV_SAFEPOINT,
                     ws->current_val, ws->sp, ws->remaining_steps);
  trace_capture_snapshot(worker_id, ws, step_counter, epoch, false);
}

void arena_trace_init(uint32_t worker_count) {
  TRACE_WORKER_COUNT = worker_count > MAX_WORKERS ? MAX_WORKERS : worker_count;
  atomic_store_explicit(&TRACE_REQUESTED_EPOCH, 0, memory_order_release);
  memset(WORKER_TRACE, 0, sizeof(WORKER_TRACE));
  for (uint32_t i = 0; i < MAX_WORKERS; i++) {
    atomic_init(&WORKER_TRACE[i].live_status, WORKER_IDLE);
    atomic_init(&WORKER_TRACE[i].live_req_id, 0);
    atomic_init(&WORKER_TRACE[i].live_current_val, EMPTY);
    atomic_init(&WORKER_TRACE[i].live_remaining_steps, 0);
    atomic_init(&WORKER_TRACE[i].live_mode, MODE_DESCEND);
    atomic_init(&WORKER_TRACE[i].live_sp, 0);
    atomic_init(&WORKER_TRACE[i].last_seen_epoch, 0);
    atomic_init(&WORKER_TRACE[i].snapshot_epoch_done, 0);
    atomic_init(&WORKER_TRACE[i].live_thread_id, 0);
    atomic_init(&WORKER_TRACE[i].live_step_counter, 0);
    atomic_init(&WORKER_TRACE[i].ring_head, 0);
  }
}

void arena_trace_request_epoch(uint32_t epoch) {
  atomic_store_explicit(&TRACE_REQUESTED_EPOCH, epoch, memory_order_release);
}

void arena_trace_capture_idle_workers(uint32_t epoch, uint32_t worker_count) {
  uint32_t limit = worker_count < TRACE_WORKER_COUNT ? worker_count : TRACE_WORKER_COUNT;
  for (uint32_t i = 0; i < limit; i++) {
    uint32_t status = atomic_load_explicit(&WORKER_TRACE[i].live_status, memory_order_acquire);
    if (status != WORKER_RUNNING) {
      trace_capture_snapshot(i, NULL, 0, epoch, true);
    }
  }
}

bool arena_trace_wait_for_epoch(uint32_t epoch, uint32_t worker_count,
                                uint32_t timeout_ms) {
  uint32_t limit = worker_count < TRACE_WORKER_COUNT ? worker_count : TRACE_WORKER_COUNT;
  uint32_t waited_ms = 0;
  while (true) {
    bool all_done = true;
    for (uint32_t i = 0; i < limit; i++) {
      uint32_t status = atomic_load_explicit(&WORKER_TRACE[i].live_status, memory_order_acquire);
      uint32_t done = atomic_load_explicit(&WORKER_TRACE[i].snapshot_epoch_done,
                                           memory_order_acquire);
      if (status == WORKER_RUNNING && done != epoch) {
        all_done = false;
        break;
      }
    }
    if (all_done)
      return true;
    if (waited_ms >= timeout_ms)
      return false;
#if defined(__linux__) && !defined(__wasm__)
    host_sleep_ms(1);
#else
    worker_cooperative_yield();
#endif
    waited_ms++;
  }
}

static void trace_write_frames_json(FILE *out, const WorkerTraceSnapshot *snap) {
  fprintf(out, "[");
  for (uint32_t i = 0; i < snap->control_count; i++) {
    const Frame *frame = &snap->control_stack[i];
    if (i > 0)
      fprintf(out, ",");
    fprintf(out,
            "{\"index\":%u,\"kind\":%u,\"submode\":%u,\"a\":%u,\"b\":%u}",
            snap->control_base + i, frame->kind, frame->submode, frame->a,
            frame->b);
  }
  fprintf(out, "]");
}

static void trace_write_events_json(FILE *out, const WorkerTraceSnapshot *snap) {
  fprintf(out, "[");
  for (uint32_t i = 0; i < snap->event_count; i++) {
    const TraceEvent *ev = &snap->recent_events[i];
    if (i > 0)
      fprintf(out, ",");
    fprintf(out,
            "{\"step\":%llu,\"kind\":\"%s\",\"a\":%u,\"b\":%u,\"c\":%u,\"req_id\":%u}",
            (unsigned long long)ev->step, trace_event_kind_name(ev->kind),
            ev->a, ev->b, ev->c, ev->req_id);
  }
  fprintf(out, "]");
}

static void trace_write_graph_json(FILE *out, const WorkerTraceSnapshot *snap) {
  fprintf(out, "[");
  for (uint32_t i = 0; i < snap->graph_count; i++) {
    const TraceGraphNode *node = &snap->focus_graph[i];
    if (i > 0)
      fprintf(out, ",");
    fprintf(out,
            "{\"node\":%u,\"kind\":\"%s\",\"left\":%u,\"right\":%u",
            node->node_id, trace_arena_kind_name(node->kind), node->left,
            node->right);
    if (node->kind == ARENA_KIND_TERMINAL) {
      fprintf(out, ",\"sym\":\"%s\"}", trace_arena_sym_name(node->sym));
    } else if (node->kind == ARENA_KIND_J) {
      fprintf(out, ",\"immediate\":\"J\",\"value\":%u}", node->sym);
    } else if (node->kind == ARENA_KIND_V) {
      fprintf(out, ",\"immediate\":\"V\",\"value\":%u}", node->sym);
    } else if (node->kind == ARENA_KIND_U8) {
      fprintf(out, ",\"u8\":%u}", node->sym);
    } else {
      fprintf(out, "}");
    }
  }
  fprintf(out, "]");
}

bool arena_trace_write_dump_json(const char *path, uint32_t epoch,
                                 uint32_t worker_count, bool timed_out) {
  if (path == NULL || path[0] == 0)
    return false;
  FILE *out = fopen(path, "w");
  if (out == NULL)
    return false;

  uint32_t top = arena_top();
  uint32_t capacity = arena_capacity();
  unsigned long long total_nodes = arena_total_nodes();
  unsigned long long total_steps = arena_total_steps();
  unsigned long long total_link_chase_hops = arena_total_link_chase_hops();
  unsigned long long total_cons_allocs = arena_total_cons_allocs();
  unsigned long long total_cont_allocs = arena_total_cont_allocs();
  unsigned long long total_susp_allocs = arena_total_susp_allocs();
  unsigned long long duplicate_lost_allocs = arena_duplicate_lost_allocs();
  unsigned long long hashcons_hits = arena_hashcons_hits();
  unsigned long long hashcons_misses = arena_hashcons_misses();

  fprintf(out,
          "{\"dump_version\":1,\"epoch\":%u,\"timed_out\":%s,\"runtime\":{\"worker_count\":%u,\"top\":%u,\"capacity\":%u,\"live_nodes_estimate\":%u,\"total_nodes\":%llu,\"total_steps\":%llu,\"total_link_chase_hops\":%llu,\"total_cons_allocs\":%llu,\"total_cont_allocs\":%llu,\"total_susp_allocs\":%llu,\"duplicate_lost_allocs\":%llu,\"hashcons_hits\":%llu,\"hashcons_misses\":%llu},\"workers\":[",
          epoch, timed_out ? "true" : "false", worker_count, top, capacity,
          top, total_nodes, total_steps, total_link_chase_hops,
          total_cons_allocs, total_cont_allocs, total_susp_allocs,
          duplicate_lost_allocs, hashcons_hits, hashcons_misses);

  uint32_t limit = worker_count < TRACE_WORKER_COUNT ? worker_count : TRACE_WORKER_COUNT;
  for (uint32_t i = 0; i < limit; i++) {
    WorkerTraceState *ts = &WORKER_TRACE[i];
    uint32_t done_epoch = atomic_load_explicit(&ts->snapshot_epoch_done, memory_order_acquire);
    if (done_epoch != epoch) {
      uint32_t status = atomic_load_explicit(&ts->live_status, memory_order_acquire);
      if (status != WORKER_RUNNING) {
        trace_capture_snapshot(i, NULL, 0, epoch, true);
        done_epoch = epoch;
      }
    }
    WorkerTraceSnapshot live_fallback;
    memset(&live_fallback, 0, sizeof(live_fallback));
    const WorkerTraceSnapshot *snap = &ts->snapshot;
    bool complete = (done_epoch == epoch);
    if (!complete) {
      live_fallback.worker_id = i;
      live_fallback.status = atomic_load_explicit(&ts->live_status, memory_order_acquire);
      live_fallback.req_id = atomic_load_explicit(&ts->live_req_id, memory_order_acquire);
      live_fallback.current_val = atomic_load_explicit(&ts->live_current_val, memory_order_acquire);
      live_fallback.remaining_steps = atomic_load_explicit(&ts->live_remaining_steps, memory_order_acquire);
      live_fallback.mode = atomic_load_explicit(&ts->live_mode, memory_order_acquire);
      live_fallback.control_depth = atomic_load_explicit(&ts->live_sp, memory_order_acquire);
      live_fallback.thread_id = atomic_load_explicit(&ts->live_thread_id, memory_order_acquire);
      live_fallback.step_counter = atomic_load_explicit(&ts->live_step_counter, memory_order_acquire);
      snap = &live_fallback;
    }
    if (i > 0)
      fprintf(out, ",");
    fprintf(out,
            "{\"worker_id\":%u,\"complete\":%s,\"thread_id\":%llu,\"state\":\"%s\",\"step_counter\":%llu,\"task_id\":%u,\"mode\":\"%s\",\"remaining_steps\":%u,\"control_depth\":%u,\"focus\":{",
            i, complete ? "true" : "false", (unsigned long long)snap->thread_id,
            trace_worker_status_name(snap->status),
            (unsigned long long)snap->step_counter, snap->req_id,
            trace_mode_name(snap->mode), snap->remaining_steps,
            snap->control_depth);
    if (snap->graph_count > 0) {
      const TraceGraphNode *focus = &snap->focus_graph[0];
      fprintf(out,
              "\"node\":%u,\"kind\":\"%s\"",
              focus->node_id, trace_arena_kind_name(focus->kind));
      if (focus->kind == ARENA_KIND_TERMINAL) {
        fprintf(out, ",\"sym\":\"%s\"",
                trace_arena_sym_name(focus->sym));
      } else if (focus->kind == ARENA_KIND_J) {
        fprintf(out, ",\"immediate\":\"J\",\"value\":%u", focus->sym);
      } else if (focus->kind == ARENA_KIND_V) {
        fprintf(out, ",\"immediate\":\"V\",\"value\":%u", focus->sym);
      } else if (focus->kind == ARENA_KIND_U8) {
        fprintf(out, ",\"u8\":%u", focus->sym);
      }
    } else {
      fprintf(out, "\"node\":%u", snap->current_val);
    }
    fprintf(out,
            "},\"control_stack\":");
    trace_write_frames_json(out, snap);
    fprintf(out, ",\"recent_events\":");
    trace_write_events_json(out, snap);
    fprintf(out, ",\"focus_graph\":");
    trace_write_graph_json(out, snap);
    fprintf(out, "}");
  }

  fprintf(out, "],\"symbols\":{}}\n");
  fclose(out);
  return true;
}

#else
static inline void trace_publish_live(uint32_t worker_id, const WorkerState *ws,
                                      uint64_t step_counter) {
  (void)worker_id;
  (void)ws;
  (void)step_counter;
}
static inline void trace_record_event(uint32_t worker_id, uint64_t step_counter,
                                      uint32_t req_id, uint32_t kind,
                                      uint32_t a, uint32_t b, uint32_t c) {
  (void)worker_id;
  (void)step_counter;
  (void)req_id;
  (void)kind;
  (void)a;
  (void)b;
  (void)c;
}
static inline void trace_maybe_snapshot(uint32_t worker_id, WorkerState *ws,
                                        uint64_t step_counter) {
  (void)worker_id;
  (void)ws;
  (void)step_counter;
}
void arena_trace_init(uint32_t worker_count) { (void)worker_count; }
void arena_trace_request_epoch(uint32_t epoch) { (void)epoch; }
void arena_trace_capture_idle_workers(uint32_t epoch, uint32_t worker_count) {
  (void)epoch;
  (void)worker_count;
}
bool arena_trace_wait_for_epoch(uint32_t epoch, uint32_t worker_count,
                                uint32_t timeout_ms) {
  (void)epoch;
  (void)worker_count;
  (void)timeout_ms;
  return true;
}
bool arena_trace_write_dump_json(const char *path, uint32_t epoch,
                                 uint32_t worker_count, bool timed_out) {
  (void)path;
  (void)epoch;
  (void)worker_count;
  (void)timed_out;
  return false;
}
#endif

/* Parking transfers ownership from the live Tier A slice to Tier B/Tier C. */
static bool park_worker_state(uint32_t slice_id, WorkerState *ws,
                              SuspensionReason reason, uint32_t wait_token,
                              uint32_t *out_susp_ptr) {
  SabHeader *h = (SabHeader *)ARENA_BASE_ADDR;
  ControlViews cv = control_views();
  uint32_t cont_slot = control_pop_cont(cv);
  if (cont_slot == EMPTY)
    return false;

  atomic_fetch_add_explicit(&h->total_cont_allocs, 1, memory_order_relaxed);

  ReifiedCont *cont = &cv.conts[cont_slot];
  cont->current_val = ws->current_val;
  cont->saved_sp = ws->sp;
  cont->remaining_steps = ws->remaining_steps;
  cont->mode = ws->mode;
  cont->reserved = 0;
  if (ws->sp > 0) {
    memcpy(cont->frames, control_worker_frames(cv, slice_id),
           ws->sp * sizeof(Frame));
  }

  uint32_t susp_slot = control_pop_susp(cv);
  if (susp_slot == EMPTY) {
    control_push_cont(cv, cont_slot);
    return false;
  }

  atomic_fetch_add_explicit(&h->total_susp_allocs, 1, memory_order_relaxed);

  Suspension *susp = &cv.suspensions[susp_slot];
  susp->reason = (uint8_t)reason;
  susp->cont_ptr = control_cont_ptr_from_slot(cont_slot);
  susp->wait_token = wait_token;
  atomic_store_explicit(&susp->status, SUSP_STATUS_PARKED,
                        memory_order_release);
  worker_reset_state(ws, WORKER_IDLE);
  atomic_fetch_add_explicit(&cv.header->park_count, 1, memory_order_relaxed);
  if (out_susp_ptr != NULL)
    *out_susp_ptr = control_susp_ptr_from_slot(susp_slot);
  return true;
}

static bool control_try_claim_suspension(Suspension *susp) {
  if (susp->flags != SUSP_FLAG_ALLOCATED)
    return false;

  uint8_t expected = SUSP_STATUS_PARKED;
  if (atomic_compare_exchange_strong_explicit(
          &susp->status, &expected, SUSP_STATUS_CLAIMED, memory_order_acq_rel,
          memory_order_acquire)) {
    return true;
  }

  if (expected != SUSP_STATUS_READY)
    return false;

  expected = SUSP_STATUS_READY;
  return atomic_compare_exchange_strong_explicit(
      &susp->status, &expected, SUSP_STATUS_CLAIMED, memory_order_acq_rel,
      memory_order_acquire);
}

/* Only one worker may successfully claim a parked suspension for resume. */
static bool resume_worker_state(uint32_t slice_id, uint32_t susp_ptr,
                                WorkerState *ws) {
  ControlViews cv = control_views();
  Suspension *susp = control_susp_from_ptr(cv, susp_ptr);
  if (susp == NULL || !control_try_claim_suspension(susp))
    return false;

  uint32_t cont_ptr = susp->cont_ptr;
  ReifiedCont *cont = control_cont_from_ptr(cv, cont_ptr);
  if (cont == NULL || cont->flags != CONT_FLAG_ALLOCATED)
    trap_invariant();
  if (cont->saved_sp > CONTROL_MAX_FRAMES)
    trap_invariant();

  ws->current_val = cont->current_val;
  ws->sp = cont->saved_sp;
  ws->remaining_steps = cont->remaining_steps;
  ws->mode = cont->mode;
  ws->status = WORKER_RUNNING;
  ws->reserved = 0;
  if (ws->sp > 0) {
    memcpy(control_worker_frames(cv, slice_id), cont->frames,
           ws->sp * sizeof(Frame));
  }
  worker_track_sp(cv, slice_id, ws->sp);

  atomic_fetch_add_explicit(&cv.header->resume_count, 1, memory_order_relaxed);
  control_push_cont(cv, control_index(cont_ptr) - CONTROL_CONT_BASE);
  control_push_susp(cv, control_index(susp_ptr) - CONTROL_SUSP_BASE);
  return true;
}

static inline void worker_cooperative_yield(void) {
#ifdef __wasm__
  /* Temporary host-yield stub: the zero-timeout wait is only a rendezvous
   * hint, not a durable notify/wake protocol yet. */
  SabHeader *h = (SabHeader *)ARENA_BASE_ADDR;
  atomic_uint *gate = &h->global_epoch;
  uint32_t observed = atomic_load_explicit(gate, memory_order_relaxed);
  __builtin_wasm_memory_atomic_wait32((int *)gate, (int)observed, 0);
#elif defined(__linux__)
  host_yield();
#else
  host_yield();
#endif
}

uint32_t controlSuspensionReason(uint32_t ptr) {
  ensure_arena();
  ControlViews cv = control_views();
  Suspension *susp = control_susp_from_ptr(cv, ptr);
  if (susp == NULL || susp->flags != SUSP_FLAG_ALLOCATED)
    return 0;
  return susp->reason;
}

uint32_t controlSuspensionCurrentValue(uint32_t ptr) {
  ensure_arena();
  ControlViews cv = control_views();
  Suspension *susp = control_susp_from_ptr(cv, ptr);
  if (susp == NULL || susp->flags != SUSP_FLAG_ALLOCATED)
    return 0;
  ReifiedCont *cont = control_cont_from_ptr(cv, susp->cont_ptr);
  return (cont == NULL) ? 0 : cont->current_val;
}

uint32_t controlSuspensionRemainingSteps(uint32_t ptr) {
  ensure_arena();
  ControlViews cv = control_views();
  Suspension *susp = control_susp_from_ptr(cv, ptr);
  if (susp == NULL || susp->flags != SUSP_FLAG_ALLOCATED)
    return 0;
  ReifiedCont *cont = control_cont_from_ptr(cv, susp->cont_ptr);
  return (cont == NULL) ? 0 : cont->remaining_steps;
}

__attribute__((no_sanitize("address"), noinline)) static void
zero_buckets(atomic_uint *buckets, uint32_t n) {
  for (uint32_t i = 0; i < n; i++)
    atomic_store_explicit(&buckets[i], EMPTY, memory_order_release);
}

__attribute__((no_sanitize("address"))) static void grow(void) {
  SabHeader *h = (SabHeader *)ARENA_BASE_ADDR;
  uint32_t expected =
      atomic_load_explicit(&h->resize_seq, memory_order_acquire);
  while (true) {
    if (expected & 1) {
      expected = atomic_load_explicit(&h->resize_seq, memory_order_acquire);
      continue;
    }
    uint32_t next = expected | 1;
    if (atomic_compare_exchange_weak_explicit(&h->resize_seq, &expected, next,
                                              memory_order_acq_rel,
                                              memory_order_acquire)) {
      break;
    }
  }

  /* QSBR: bump epoch so new readers use new epoch; then wait for all active
   * readers to leave the old epoch (drain). */
  uint32_t new_epoch =
      atomic_fetch_add_explicit(&h->global_epoch, 1, memory_order_acq_rel) + 1;
  for (uint32_t i = 0; i < MAX_WORKERS; i++) {
    while (true) {
      uint32_t w_epoch =
          atomic_load_explicit(&h->worker_epochs[i], memory_order_acquire);
      if (w_epoch == 0 || w_epoch >= new_epoch)
        break;
#if defined(__linux__) && !defined(__wasm__)
      __builtin_ia32_pause();
#elif defined(__x86_64__) || defined(_M_X64)
      __builtin_ia32_pause();
#else
      /* Yield so reader can finish its batch. */
      (void)0;
#endif
    }
  }

  uint32_t old_cap = atomic_load_explicit(&h->capacity, memory_order_relaxed);
  uint32_t max_cap = h->max_capacity;
  if (max_cap == 0 || max_cap > MAX_CAP)
    max_cap = MAX_CAP;

  if (old_cap >= max_cap ||
      (old_cap * 2) <=
          atomic_load_explicit(&h->capacity, memory_order_relaxed)) {
    atomic_fetch_add_explicit(&h->resize_seq, 1, memory_order_release);
    return;
  }
  if (atomic_load_explicit(&h->top, memory_order_acquire) < old_cap) {
    atomic_fetch_add_explicit(&h->resize_seq, 1, memory_order_release);
    return;
  }

  uint32_t old_top = atomic_load_explicit(&h->top, memory_order_acquire);

  uint32_t new_cap = old_cap * 2;
  if (new_cap > max_cap)
    new_cap = max_cap;
#ifndef __wasm__
  /* Cap so we never write past the actual mmap (defense-in-depth). */
  if (ARENA_RESERVED_BYTES > 0) {
    while (new_cap > old_cap) {
      SabLayout probe = calculate_layout(new_cap, max_cap);
      if ((size_t)probe.total_size <= ARENA_RESERVED_BYTES)
        break;
      new_cap--;
    }
    if (new_cap <= old_cap) {
      atomic_fetch_add_explicit(&h->resize_seq, 1, memory_order_release);
      return; /* cannot grow within reservation */
    }
  }
#endif
  uint32_t grow_num =
      atomic_fetch_add_explicit(&h->grow_count, 1, memory_order_relaxed) + 1;
#ifndef __wasm__
  fprintf(stderr, "Arena: grow #%u %u -> %u (top=%u)\n", grow_num, old_cap,
          new_cap, old_top);
#else
  (void)grow_num;
#endif

  SabLayout layout = calculate_layout(new_cap, max_cap);

#ifdef __wasm__
  uint32_t current_bytes = __builtin_wasm_memory_size(0) * WASM_PAGE_SIZE;
  uintptr_t needed_end =
      (uintptr_t)ARENA_BASE_ADDR + (uintptr_t)layout.total_size;
  if (needed_end > current_bytes) {
    uint32_t extra = needed_end - current_bytes;
    uint32_t pages = (extra + WASM_PAGE_SIZE - 1) / WASM_PAGE_SIZE;
    size_t previous_pages = __builtin_wasm_memory_grow(0, pages);
    if (previous_pages == (size_t)-1) {
      atomic_store_explicit(&h->resize_seq, POISON_SEQ, memory_order_release);
      __builtin_trap();
    }
  }
#else

  if (!commit_arena_capacity_ranges(&layout, old_cap, new_cap, false)) {
    atomic_store_explicit(&h->resize_seq, POISON_SEQ, memory_order_release);
    abort();
  }

#endif

  atomic_store_explicit(&h->capacity, new_cap, memory_order_release);
  h->bucket_mask = new_cap - 1;
  h->offset_sq = layout.offset_sq;
  h->offset_cq = layout.offset_cq;
  h->offset_stdin = layout.offset_stdin;
  h->offset_stdout = layout.offset_stdout;
  h->offset_stdin_wait = layout.offset_stdin_wait;
  h->offset_stdout_wait = layout.offset_stdout_wait;
  h->offset_control = layout.offset_control;
  h->control_bytes = layout.control_bytes;
  h->offset_term_cache = layout.offset_term_cache;
  h->offset_node_left = layout.offset_node_left;
  h->offset_node_right = layout.offset_node_right;
  h->offset_node_hash32 = layout.offset_node_hash32;
  h->offset_node_next_idx = layout.offset_node_next_idx;
  h->offset_node_link = layout.offset_node_link;
  h->offset_node_kind = layout.offset_node_kind;
  h->offset_node_sym = layout.offset_node_sym;
  h->offset_buckets = layout.offset_buckets;
  h->max_capacity = max_cap;

  /* Layout sanity assertions. */
  ARENA_ASSERT(h->offset_node_left < h->offset_node_right);
  ARENA_ASSERT(h->offset_node_right < h->offset_node_hash32);
  ARENA_ASSERT(h->offset_node_hash32 < h->offset_node_next_idx);
  ARENA_ASSERT(h->offset_node_next_idx < h->offset_node_link);
  ARENA_ASSERT(h->offset_node_link < h->offset_node_kind);
  ARENA_ASSERT(h->offset_node_kind < h->offset_node_sym);
  ARENA_ASSERT(h->offset_node_sym < h->offset_buckets);
#ifndef __wasm__
  if (ARENA_RESERVED_BYTES > 0) {
    ARENA_ASSERT(layout.total_size <= ARENA_RESERVED_BYTES);
  }
#endif

  atomic_uchar *kinds = (atomic_uchar *)(ARENA_BASE_ADDR + h->offset_node_kind);
  atomic_uint *hashes =
      (atomic_uint *)(ARENA_BASE_ADDR + h->offset_node_hash32);
  atomic_uint *next_idxs =
      (atomic_uint *)(ARENA_BASE_ADDR + h->offset_node_next_idx);
  atomic_uint *new_buckets =
      (atomic_uint *)(ARENA_BASE_ADDR + h->offset_buckets);

  /* Zero new node slots [old_cap .. new_cap-1] (existing nodes never moved). */
  if (new_cap > old_cap) {
    uint32_t diff = new_cap - old_cap;
    memset(ARENA_BASE_ADDR + h->offset_node_left + old_cap * 4, 0, diff * 4);
    memset(ARENA_BASE_ADDR + h->offset_node_right + old_cap * 4, 0, diff * 4);
    memset(ARENA_BASE_ADDR + h->offset_node_hash32 + old_cap * 4, 0, diff * 4);
    memset(ARENA_BASE_ADDR + h->offset_node_next_idx + old_cap * 4, 0,
           diff * 4);
    memset(ARENA_BASE_ADDR + h->offset_node_link + old_cap * 4, 0xff, diff * 4);
    memset(ARENA_BASE_ADDR + h->offset_node_kind + old_cap * 1, 0, diff * 1);
    memset(ARENA_BASE_ADDR + h->offset_node_sym + old_cap * 1, 0, diff * 1);
  }

  zero_buckets(new_buckets, new_cap);

  uint32_t count = (old_top < old_cap) ? old_top : old_cap;
  atomic_store_explicit(&h->top, count, memory_order_release);

  /* Rehash existing NON_TERM nodes into new buckets. */
  for (uint32_t i = 0; i < count; i++) {
    if (load_kind_pub(kinds, i) != ARENA_KIND_NON_TERM)
      continue;
    uint32_t hv = load_u32_payload(hashes, i);
    uint32_t b = bucket_index(hv, h->bucket_mask);
    uint32_t head = atomic_load_explicit(&new_buckets[b], memory_order_relaxed);
    atomic_store_explicit(&next_idxs[i], head, memory_order_relaxed);
    atomic_store_explicit(&new_buckets[b], i, memory_order_relaxed);
  }

  atomic_fetch_add_explicit(&h->resize_seq, 1, memory_order_release);
}

/** Prelude true = K */
static uint32_t arenaTrue(void) {
  SabHeader *h = (SabHeader *)ARENA_BASE_ADDR;
  return h->true_id;
}

/** Prelude false = (K I) */
static uint32_t arenaFalse(void) {
  SabHeader *h = (SabHeader *)ARENA_BASE_ADDR;
  return h->false_id;
}

/** Direct node loads: fast path. Must check n < capacity so we never return
 * ids from uninitialized slots (would later write via update_continuation).
 * Use relaxed load of capacity to avoid extra sync; may rarely reject valid
 * post-grow node (then fall back to kindOf path). */
/** Direct node loads: wait-free fast paths with no live capacity check.
 * Safe because AoS nodes never move and memory is reserved up to MAX_CAP. */
static inline void control_retry_tick(void) {
  ControlViews cv = control_views();
  atomic_fetch_add_explicit(&cv.header->cooperative_retries, 1,
                            memory_order_relaxed);
  worker_cooperative_yield();
}

static StepOutcome park_budget_yield(uint32_t slice_id, WorkerState *ws,
                                     SuspensionReason reason,
                                     bool allow_retry) {
  StepOutcome out = {RESULT_YIELD, EMPTY};
  while (!park_worker_state(slice_id, ws, reason, 0, &out.val)) {
    if (!allow_retry)
      trap_invariant();
    control_retry_tick();
  }
  return out;
}

static bool maybe_park_io_wait(uint32_t slice_id, WorkerState *ws,
                               SuspensionReason reason, uint32_t wait_offset,
                               bool allow_retry, StepOutcome *out) {
  uint32_t susp_ptr = EMPTY;
  if (!park_worker_state(slice_id, ws, reason, 0, &susp_ptr)) {
    if (!allow_retry)
      trap_invariant();
    control_retry_tick();
    return false;
  }
  if (tls_worker_id < MAX_WORKERS) {
    SabHeader *h = (SabHeader *)ARENA_BASE_ADDR;
    atomic_store_explicit(&h->worker_epochs[tls_worker_id], 0,
                          memory_order_release);
  }
  enqueue_blocking((Ring *)(ARENA_BASE_ADDR + wait_offset), &susp_ptr, 4);
  out->type = RESULT_YIELD;
  out->val = susp_ptr;
  return true;
}

typedef struct {
  uint32_t end;
  bool fixpoint;
  bool truncated;
} LinkChaseResult;

static void publish_link_ptr(atomic_uint *links, uint32_t from, uint32_t to) {
  if (from >= MAX_CAP || to >= MAX_CAP || is_control_ptr(from) ||
      is_control_ptr(to))
    return;

  uint32_t current = atomic_load_explicit(&links[from], memory_order_relaxed);
  while (true) {
    if (current == from && to != from)
      return;
    if (current == to)
      return;
    if (atomic_compare_exchange_weak_explicit(&links[from], &current, to,
                                              memory_order_release,
                                              memory_order_relaxed)) {
      return;
    }
  }
}

static LinkChaseResult chase_link_path(atomic_uint *links, uint32_t start,
                                       uint32_t max_hops) {
  LinkChaseResult out = {.end = start, .fixpoint = false, .truncated = false};
  uint32_t cur = start;
  SabHeader *h = (SabHeader *)ARENA_BASE_ADDR;

  for (uint32_t hops = 0; hops < max_hops; hops++) {
    uint32_t next = load_u32_link(links, cur);
    if (next == EMPTY) {
      out.end = cur;
      return out;
    }
    if (next == cur) {
      out.end = cur;
      out.fixpoint = true;
      return out;
    }
    if (next >= MAX_CAP || is_control_ptr(next)) {
      out.truncated = true;
      return out;
    }
    atomic_fetch_add_explicit(&h->total_link_chase_hops, 1,
                              memory_order_relaxed);
    cur = next;
  }

  out.truncated = true;
  return out;
}

static void compress_link_path(atomic_uint *links, uint32_t start, uint32_t stop,
                               uint32_t target, bool write_stop,
                               uint32_t max_hops) {
  if (start >= MAX_CAP || stop >= MAX_CAP || target >= MAX_CAP ||
      is_control_ptr(start) || is_control_ptr(stop) || is_control_ptr(target))
    return;

  uint32_t cur = start;
  for (uint32_t hops = 0; hops < max_hops; hops++) {
    if (cur == stop) {
      if (write_stop)
        publish_link_ptr(links, cur, target);
      return;
    }

    uint32_t next = load_u32_link(links, cur);
    publish_link_ptr(links, cur, target);

    if (next == EMPTY || next == cur || next >= MAX_CAP || is_control_ptr(next))
      return;
    cur = next;
  }
}

static bool node_has_effectful_top_step(SabHeader *h, uint32_t node_id) {
  if (node_id >= MAX_CAP || is_control_ptr(node_id))
    return false;

  atomic_uchar *kinds = (atomic_uchar *)(ARENA_BASE_ADDR + h->offset_node_kind);
  atomic_uchar *syms = (atomic_uchar *)(ARENA_BASE_ADDR + h->offset_node_sym);
  atomic_uint *lefts = (atomic_uint *)(ARENA_BASE_ADDR + h->offset_node_left);

  if (load_kind_pub(kinds, node_id) != ARENA_KIND_NON_TERM)
    return false;

  uint32_t left = load_u32_payload(lefts, node_id);
  if (left >= MAX_CAP || load_kind_pub(kinds, left) != ARENA_KIND_TERMINAL) {
    if (left >= MAX_CAP || load_kind_pub(kinds, left) != ARENA_KIND_NON_TERM)
      return false;
    uint32_t ll = load_u32_payload(lefts, left);
    if (ll >= MAX_CAP || load_kind_pub(kinds, ll) != ARENA_KIND_TERMINAL)
      return false;
    return load_u8_payload(syms, ll) == ARENA_SYM_WRITE_ONE;
  }

  return load_u8_payload(syms, left) == ARENA_SYM_READ_ONE;
}

static bool collect_spine_head_and_argc(atomic_uchar *kinds, atomic_uint *lefts,
                                        uint32_t root, uint32_t *out_head,
                                        uint8_t *out_head_kind,
                                        uint32_t *out_argc) {
  uint32_t argc = 0;
  uint32_t node = root;

  while (node < MAX_CAP && !is_control_ptr(node) &&
         load_kind_pub(kinds, node) == ARENA_KIND_NON_TERM) {
    argc++;
    node = load_u32_payload(lefts, node);
    debug_check_child_ptr(node);
  }

  if (node >= MAX_CAP || is_control_ptr(node))
    return false;

  *out_head = node;
  *out_head_kind = load_kind_pub(kinds, node);
  *out_argc = argc;
  return true;
}

static void collect_spine_args_into(atomic_uint *lefts, atomic_uint *rights,
                                    uint32_t root, uint32_t argc,
                                    uint32_t *args) {
  uint32_t node = root;
  for (uint32_t i = argc; i > 0; i--) {
    args[i - 1u] = load_u32_payload(rights, node);
    debug_check_child_ptr(args[i - 1u]);
    node = load_u32_payload(lefts, node);
    debug_check_child_ptr(node);
  }
}

static uint32_t build_app_chain(uint32_t head, const uint32_t *args,
                                uint32_t start, uint32_t count) {
  uint32_t out = head;
  for (uint32_t i = 0; i < count; i++) {
    out = allocCons(out, args[start + i]);
  }
  return out;
}

static bool decompose_exact_partial_v(atomic_uchar *kinds, atomic_uchar *syms,
                                      atomic_uint *lefts, uint32_t expr,
                                      uint32_t *out_argc) {
  if (expr >= MAX_CAP || is_control_ptr(expr))
    return false;

  uint8_t kind = load_kind_pub(kinds, expr);
  if (kind == ARENA_KIND_V) {
    if (load_u8_payload(syms, expr) != 0)
      return false;
    *out_argc = 0;
    return true;
  }

  if (kind != ARENA_KIND_NON_TERM)
    return false;

  if (load_u8_payload(syms, expr) != IMMEDIATE_HEAD_V)
    return false;

  uint32_t head = EMPTY;
  uint32_t argc = 0;
  uint8_t head_kind = 0;
  if (!collect_spine_head_and_argc(kinds, lefts, expr, &head, &head_kind,
                                   &argc) ||
      head_kind != ARENA_KIND_V) {
    return false;
  }

  if (argc != load_u8_payload(syms, head))
    return false;

  *out_argc = argc;
  return true;
}

static bool try_reduce_immediate_spine(atomic_uchar *kinds, atomic_uchar *syms,
                                       atomic_uint *lefts,
                                       atomic_uint *rights, uint32_t root,
                                       uint32_t *out_result) {
  if (root >= MAX_CAP || is_control_ptr(root) ||
      load_kind_pub(kinds, root) != ARENA_KIND_NON_TERM) {
    return false;
  }

  uint8_t root_summary = load_u8_payload(syms, root);
  if (!immediate_head_summary_is_jv(root_summary)) {
    return false;
  }

  uint32_t head = EMPTY;
  uint32_t argc = 0;
  uint8_t head_kind = 0;
  if (!collect_spine_head_and_argc(kinds, lefts, root, &head, &head_kind,
                                   &argc)) {
    return false;
  }

  if (root_summary == IMMEDIATE_HEAD_J) {
    if (head_kind != ARENA_KIND_J) {
      return false;
    }

    uint32_t depth = load_u8_payload(syms, head);
    uint32_t saturation = depth + 2u;
    if (argc < saturation) {
      return false;
    }

    uint32_t *args =
        argc == 0 ? NULL : (uint32_t *)__builtin_alloca(argc * sizeof(uint32_t));
    collect_spine_args_into(lefts, rights, root, argc, args);

    uint32_t result = EMPTY;
    uint32_t f = args[0];
    uint32_t xn = args[depth + 1u];
    uint32_t staged_argc = 0;
    uint8_t f_kind =
        (f < MAX_CAP && !is_control_ptr(f)) ? load_kind_pub(kinds, f) : 0;

    if (f_kind == ARENA_KIND_V && load_u8_payload(syms, f) == 0) {
      result = xn;
    } else if (f_kind == ARENA_KIND_NON_TERM &&
               load_u8_payload(syms, f) == IMMEDIATE_HEAD_V &&
               decompose_exact_partial_v(kinds, syms, lefts, f,
                                         &staged_argc)) {
      uint32_t *staged = staged_argc == 0
                             ? NULL
                             : (uint32_t *)__builtin_alloca(staged_argc *
                                                            sizeof(uint32_t));
      if (staged_argc > 0)
        collect_spine_args_into(lefts, rights, f, staged_argc, staged);
      result = build_app_chain(xn, staged, 0, staged_argc);
    } else {
      result = allocCons(f, xn);
    }

    if (argc > saturation) {
      result = build_app_chain(result, args, saturation, argc - saturation);
    }

    *out_result = result;
    return true;
  }

  if (head_kind != ARENA_KIND_V) {
    return false;
  }

  uint32_t staged_argc = load_u8_payload(syms, head);
  uint32_t saturation = staged_argc + 1u;
  if (argc < saturation) {
    return false;
  }

  uint32_t *args =
      argc == 0 ? NULL : (uint32_t *)__builtin_alloca(argc * sizeof(uint32_t));
  collect_spine_args_into(lefts, rights, root, argc, args);

  uint32_t result = build_app_chain(args[staged_argc], args, 0, staged_argc);
  if (argc > saturation) {
    result = build_app_chain(result, args, saturation, argc - saturation);
  }

  *out_result = result;
  return true;
}

static StepOutcome step_iterative(uint32_t slice_id, WorkerState *ws,
                                  uint32_t *gas, SabHeader *h,
                                  bool yield_on_gas, bool yield_on_step_limit,
                                  bool allow_retry, uint64_t *step_counter) {
  ControlViews cv = control_views();
  StepOutcome out = {RESULT_DONE, EMPTY};

  atomic_uchar *kinds = (atomic_uchar *)(ARENA_BASE_ADDR + h->offset_node_kind);
  atomic_uchar *syms = (atomic_uchar *)(ARENA_BASE_ADDR + h->offset_node_sym);
  atomic_uint *lefts = (atomic_uint *)(ARENA_BASE_ADDR + h->offset_node_left);
  atomic_uint *rights = (atomic_uint *)(ARENA_BASE_ADDR + h->offset_node_right);

  while (true) {
    if (step_counter != NULL)
      (*step_counter)++;
    trace_maybe_snapshot(slice_id, ws, step_counter != NULL ? *step_counter : 0);
    atomic_fetch_add_explicit(&h->total_steps, 1, memory_order_relaxed);
    if (*gas == 0) {
      if (!yield_on_gas) {
        *gas = ARENA_STEP_GAS;
      } else {
        return park_budget_yield(slice_id, ws, SUSP_GAS_EXHAUSTED, allow_retry);
      }
    }
    (*gas)--;

    if (ws->mode == MODE_RETURN) {
      if (ws->sp == 0) {
        out.val = ws->current_val;
        return out;
      }
      Frame f = worker_pop_frame(cv, slice_id, ws);
      uint32_t parent_node = f.a;
      uint8_t stage = f.submode;

      if (stage == STAGE_LEFT) {
        uint32_t l = load_u32_payload(lefts, parent_node);
        debug_check_child_ptr(l);
        if (ws->current_val != l) {
          uint32_t r = load_u32_payload(rights, parent_node);
          debug_check_child_ptr(r);
          ws->current_val = allocCons(ws->current_val, r);
          ws->mode = MODE_RETURN;
          continue;
        }
        worker_push_frame(
            cv, slice_id, ws,
            (Frame){FRAME_UPDATE, STAGE_RIGHT, 0, parent_node, 0});
        uint32_t r = load_u32_payload(rights, parent_node);
        debug_check_child_ptr(r);
        ws->current_val = r;
        ws->mode = MODE_DESCEND;
        continue;
      }

      uint32_t r = load_u32_payload(rights, parent_node);
      debug_check_child_ptr(r);
      if (ws->current_val != r) {
        uint32_t l = load_u32_payload(lefts, parent_node);
        debug_check_child_ptr(l);
        ws->current_val = allocCons(l, ws->current_val);
      } else {
        ws->current_val = parent_node;
      }
      ws->mode = MODE_RETURN;
      continue;
    }

    uint32_t cur = ws->current_val;
    if (cur >= MAX_CAP) {
      ws->mode = MODE_RETURN;
      continue;
    }

    uint8_t cur_kind = load_kind_pub(kinds, cur);
    if (cur_kind != ARENA_KIND_NON_TERM) {
      ws->mode = MODE_RETURN;
      continue;
    }

    uint32_t left = load_u32_payload(lefts, cur);
    uint32_t right = load_u32_payload(rights, cur);
    debug_check_child_ptr(left);
    debug_check_child_ptr(right);

    uint8_t l_kind = (left < MAX_CAP) ? load_kind_pub(kinds, left) : 0;

    if (l_kind == ARENA_KIND_TERMINAL) {
      uint32_t sym = load_u8_payload(syms, left);
      if (sym == ARENA_SYM_I) {
        if (ws->remaining_steps == 0) {
          if (yield_on_step_limit) {
            return park_budget_yield(slice_id, ws, SUSP_STEP_LIMIT,
                                     allow_retry);
          }
          ws->mode = MODE_RETURN;
          continue;
        }
        ws->remaining_steps--;
        ws->current_val = right;
        ws->mode = MODE_DESCEND;
        continue;
      }
      if (sym == ARENA_SYM_READ_ONE) {
        if (ws->remaining_steps == 0) {
          if (yield_on_step_limit) {
            return park_budget_yield(slice_id, ws, SUSP_STEP_LIMIT,
                                     allow_retry);
          }
          ws->mode = MODE_RETURN;
          continue;
        }

#ifndef __wasm__
        if (atomic_load_explicit(&mmap_stdin_active, memory_order_acquire)) {
          size_t cursor = atomic_fetch_add_explicit(&mmap_stdin_cursor, 1,
                                                    memory_order_relaxed);
          if (cursor < mmap_stdin_size) {
            uint8_t byte = mmap_stdin_buf[cursor];
            ws->remaining_steps--;
            ws->current_val = allocCons(right, allocU8(byte));
            ws->mode = MODE_DESCEND;
            continue;
          } else {
            /* Deterministic EOF for finite files: return from reduction with
             * error instead of parking forever. */
            atomic_fetch_sub_explicit(&mmap_stdin_cursor, 1,
                                      memory_order_relaxed);
            StepOutcome out =
                park_budget_yield(slice_id, ws, SUSP_IO_EOF, allow_retry);
            return out;
          }
        }
#endif

        uint8_t byte;
        if (try_dequeue((Ring *)(ARENA_BASE_ADDR + h->offset_stdin), &byte,
                        1)) {
          ws->remaining_steps--;
          ws->current_val = allocCons(right, allocU8(byte));
          ws->mode = MODE_DESCEND;
          continue;
        }
        if (maybe_park_io_wait(slice_id, ws, SUSP_WAIT_IO_STDIN,
                               h->offset_stdin_wait, allow_retry, &out)) {
          return out;
        }
        continue;
      }
    } else if (l_kind == ARENA_KIND_NON_TERM) {
      uint32_t ll = load_u32_payload(lefts, left);
      debug_check_child_ptr(ll);
      uint8_t ll_kind = (ll < MAX_CAP) ? load_kind_pub(kinds, ll) : 0;
      if (ll_kind == ARENA_KIND_TERMINAL) {
        uint32_t sym = load_u8_payload(syms, ll);
        if (sym == ARENA_SYM_WRITE_ONE) {
          uint32_t byte_node = load_u32_payload(rights, left);
          debug_check_child_ptr(byte_node);
          if (byte_node < MAX_CAP &&
              load_kind_pub(kinds, byte_node) == ARENA_KIND_U8) {
            if (ws->remaining_steps == 0) {
              if (yield_on_step_limit) {
                return park_budget_yield(slice_id, ws, SUSP_STEP_LIMIT,
                                         allow_retry);
              }
              ws->mode = MODE_RETURN;
              continue;
            }

            uint8_t byte = (uint8_t)load_u8_payload(syms, byte_node);

#ifndef __wasm__
            if (mmap_stdout_buf != NULL) {
              size_t cursor = atomic_fetch_add_explicit(&mmap_stdout_cursor, 1,
                                                        memory_order_relaxed);
              if (cursor < mmap_stdout_size) {
                mmap_stdout_buf[cursor] = byte;
                ws->remaining_steps--;
                ws->current_val = allocCons(right, byte_node);
                ws->mode = MODE_DESCEND;
                continue;
              } else {
                /* Overflow: deterministic failure. */
                atomic_fetch_sub_explicit(&mmap_stdout_cursor, 1,
                                          memory_order_relaxed);
                StepOutcome out =
                    park_budget_yield(slice_id, ws, SUSP_IO_ERROR, allow_retry);
                return out;
              }
            }
#endif

            if (try_enqueue((Ring *)(ARENA_BASE_ADDR + h->offset_stdout), &byte,
                            1)) {
              ws->remaining_steps--;
              ws->current_val = allocCons(right, byte_node);
              ws->mode = MODE_DESCEND;
              continue;
            }
            if (maybe_park_io_wait(slice_id, ws, SUSP_WAIT_IO_STDOUT,
                                   h->offset_stdout_wait, allow_retry, &out)) {
              return out;
            }
            continue;
          }
        }
        if (sym >= ARENA_SYM_EQ_U8 && sym <= ARENA_SYM_SUB_U8) {
          uint32_t a = load_u32_payload(rights, left);
          uint32_t b = right;
          debug_check_child_ptr(a);
          debug_check_child_ptr(b);
          if (a < MAX_CAP && b < MAX_CAP) {
            uint8_t ka = load_kind_pub(kinds, a);
            uint8_t kb = load_kind_pub(kinds, b);
            if (ka == ARENA_KIND_U8 && kb == ARENA_KIND_U8) {
              if (ws->remaining_steps == 0) {
                if (yield_on_step_limit) {
                  return park_budget_yield(slice_id, ws, SUSP_STEP_LIMIT,
                                           allow_retry);
                }
                ws->mode = MODE_RETURN;
                continue;
              }
              ws->remaining_steps--;
              uint8_t va = (uint8_t)load_u8_payload(syms, a);
              uint8_t vb = (uint8_t)load_u8_payload(syms, b);

              switch (sym) {
              case ARENA_SYM_EQ_U8:
                ws->current_val = (va == vb) ? arenaTrue() : arenaFalse();
                break;
              case ARENA_SYM_LT_U8:
                ws->current_val = (va < vb) ? arenaTrue() : arenaFalse();
                break;
              case ARENA_SYM_DIV_U8:
                ws->current_val = allocU8(vb == 0 ? 0 : va / vb);
                break;
              case ARENA_SYM_MOD_U8:
                ws->current_val = allocU8(vb == 0 ? 0 : va % vb);
                break;
              case ARENA_SYM_ADD_U8:
                ws->current_val = allocU8((uint8_t)(va + vb));
                break;
              case ARENA_SYM_SUB_U8:
                ws->current_val = allocU8((uint8_t)(va - vb));
                break;
              }
              ws->mode = MODE_DESCEND;
              continue;
            }
          }
        }
      }
      if (ll_kind == ARENA_KIND_TERMINAL &&
          load_u8_payload(syms, ll) == ARENA_SYM_K) {
        if (ws->remaining_steps == 0) {
          if (yield_on_step_limit) {
            return park_budget_yield(slice_id, ws, SUSP_STEP_LIMIT,
                                     allow_retry);
          }
          ws->mode = MODE_RETURN;
          continue;
        }
        ws->remaining_steps--;
        uint32_t r_left = load_u32_payload(rights, left);
        debug_check_child_ptr(r_left);
        ws->current_val = r_left;
        ws->mode = MODE_DESCEND;
        continue;
      }
      if (ll_kind == ARENA_KIND_NON_TERM) {
        uint32_t lll = load_u32_payload(lefts, ll);
        debug_check_child_ptr(lll);
        uint8_t lll_kind = (lll < MAX_CAP) ? load_kind_pub(kinds, lll) : 0;
        if (lll_kind == ARENA_KIND_TERMINAL) {
          uint32_t sym = load_u8_payload(syms, lll);
          if (sym == ARENA_SYM_S) {
            if (ws->remaining_steps == 0) {
              if (yield_on_step_limit) {
                return park_budget_yield(slice_id, ws, SUSP_STEP_LIMIT,
                                         allow_retry);
              }
              ws->mode = MODE_RETURN;
              continue;
            }
            ws->remaining_steps--;
            uint32_t x = load_u32_payload(rights, ll);
            uint32_t y = load_u32_payload(rights, left);
            uint32_t z = right;
            debug_check_child_ptr(x);
            debug_check_child_ptr(y);
            debug_check_child_ptr(z);
            ws->current_val = allocCons(allocCons(x, z), allocCons(y, z));
            ws->mode = MODE_DESCEND;
            continue;
          }
          if (sym == ARENA_SYM_B) {
            if (ws->remaining_steps == 0) {
              if (yield_on_step_limit) {
                return park_budget_yield(slice_id, ws, SUSP_STEP_LIMIT,
                                         allow_retry);
              }
              ws->mode = MODE_RETURN;
              continue;
            }
            ws->remaining_steps--;
            uint32_t x = load_u32_payload(rights, ll);
            uint32_t y = load_u32_payload(rights, left);
            uint32_t z = right;
            debug_check_child_ptr(x);
            debug_check_child_ptr(y);
            debug_check_child_ptr(z);
            ws->current_val = allocCons(x, allocCons(y, z));
            ws->mode = MODE_DESCEND;
            continue;
          }
          if (sym == ARENA_SYM_C) {
            if (ws->remaining_steps == 0) {
              if (yield_on_step_limit) {
                return park_budget_yield(slice_id, ws, SUSP_STEP_LIMIT,
                                         allow_retry);
              }
              ws->mode = MODE_RETURN;
              continue;
            }
            ws->remaining_steps--;
            uint32_t x = load_u32_payload(rights, ll);
            uint32_t y = load_u32_payload(rights, left);
            uint32_t z = right;
            debug_check_child_ptr(x);
            debug_check_child_ptr(y);
            debug_check_child_ptr(z);
            ws->current_val = allocCons(allocCons(x, z), y);
            ws->mode = MODE_DESCEND;
            continue;
          }
        } else if (lll_kind == ARENA_KIND_NON_TERM) {
          uint32_t llll = load_u32_payload(lefts, lll);
          debug_check_child_ptr(llll);
          uint8_t llll_kind = (llll < MAX_CAP) ? load_kind_pub(kinds, llll) : 0;
          if (llll_kind == ARENA_KIND_TERMINAL) {
            uint32_t sym = load_u8_payload(syms, llll);
            if (sym == ARENA_SYM_SPRIME) {
              if (ws->remaining_steps == 0) {
                if (yield_on_step_limit) {
                  return park_budget_yield(slice_id, ws, SUSP_STEP_LIMIT,
                                           allow_retry);
                }
                ws->mode = MODE_RETURN;
                continue;
              }
              ws->remaining_steps--;
              uint32_t w = load_u32_payload(rights, lll);
              uint32_t x = load_u32_payload(rights, ll);
              uint32_t y = load_u32_payload(rights, left);
              uint32_t z = right;
              debug_check_child_ptr(w);
              debug_check_child_ptr(x);
              debug_check_child_ptr(y);
              debug_check_child_ptr(z);
              ws->current_val =
                  allocCons(allocCons(w, allocCons(x, z)), allocCons(y, z));
              ws->mode = MODE_DESCEND;
              continue;
            }
            if (sym == ARENA_SYM_BPRIME) {
              if (ws->remaining_steps == 0) {
                if (yield_on_step_limit) {
                  return park_budget_yield(slice_id, ws, SUSP_STEP_LIMIT,
                                           allow_retry);
                }
                ws->mode = MODE_RETURN;
                continue;
              }
              ws->remaining_steps--;
              uint32_t w = load_u32_payload(rights, lll);
              uint32_t x = load_u32_payload(rights, ll);
              uint32_t y = load_u32_payload(rights, left);
              uint32_t z = right;
              debug_check_child_ptr(w);
              debug_check_child_ptr(x);
              debug_check_child_ptr(y);
              debug_check_child_ptr(z);
              ws->current_val = allocCons(allocCons(w, x), allocCons(y, z));
              ws->mode = MODE_DESCEND;
              continue;
            }
            if (sym == ARENA_SYM_CPRIME) {
              if (ws->remaining_steps == 0) {
                if (yield_on_step_limit) {
                  return park_budget_yield(slice_id, ws, SUSP_STEP_LIMIT,
                                           allow_retry);
                }
                ws->mode = MODE_RETURN;
                continue;
              }
              ws->remaining_steps--;
              uint32_t w = load_u32_payload(rights, lll);
              uint32_t x = load_u32_payload(rights, ll);
              uint32_t y = load_u32_payload(rights, left);
              uint32_t z = right;
              debug_check_child_ptr(w);
              debug_check_child_ptr(x);
              debug_check_child_ptr(y);
              debug_check_child_ptr(z);
              ws->current_val = allocCons(allocCons(w, allocCons(x, z)), y);
              ws->mode = MODE_DESCEND;
              continue;
            }
          }
        }
      }
    }

    if (immediate_head_summary_is_jv(load_u8_payload(syms, cur))) {
      uint32_t reduced = EMPTY;
      if (try_reduce_immediate_spine(kinds, syms, lefts, rights, cur,
                                     &reduced)) {
        if (ws->remaining_steps == 0) {
          if (yield_on_step_limit) {
            return park_budget_yield(slice_id, ws, SUSP_STEP_LIMIT,
                                     allow_retry);
          }
          ws->mode = MODE_RETURN;
          continue;
        }
        ws->remaining_steps--;
        ws->current_val = reduced;
        ws->mode = MODE_DESCEND;
        continue;
      }
    }

    worker_push_frame(cv, slice_id, ws,
                      (Frame){FRAME_UPDATE, STAGE_LEFT, 0, ws->current_val, 0});
    ws->current_val = left;
    ws->mode = MODE_DESCEND;
  }
}

static StepOutcome step_once_with_links(uint32_t slice_id, WorkerState *ws,
                                        uint32_t *gas, SabHeader *h,
                                        bool yield_on_gas,
                                        bool yield_on_step_limit,
                                        bool allow_retry,
                                        uint64_t *step_counter) {
#ifndef __wasm__
  if (atomic_load_explicit(&mmap_stdin_active, memory_order_acquire) ||
      mmap_stdout_buf != NULL) {
    return step_iterative(slice_id, ws, gas, h, yield_on_gas,
                          yield_on_step_limit, allow_retry, step_counter);
  }
#endif
  if (is_control_ptr(ws->current_val) || ws->current_val >= MAX_CAP) {
    return step_iterative(slice_id, ws, gas, h, yield_on_gas,
                          yield_on_step_limit, allow_retry, step_counter);
  }

  uint32_t start = ws->current_val;
  uint32_t hop_limit = atomic_load_explicit(&h->top, memory_order_acquire) + 1;
  if (hop_limit == 0)
    hop_limit = 1;

  atomic_uint *links = link_table_from_header(h);
  LinkChaseResult chase = chase_link_path(links, start, hop_limit);
  if (chase.truncated) {
    return step_iterative(slice_id, ws, gas, h, yield_on_gas,
                          yield_on_step_limit, allow_retry, step_counter);
  }

  if (chase.fixpoint) {
    if (chase.end != start) {
      compress_link_path(links, start, chase.end, chase.end, false, hop_limit);
    }
    StepOutcome out = {RESULT_DONE, chase.end};
    ws->current_val = chase.end;
    return out;
  }

  ws->current_val = chase.end;
  ws->sp = 0;
  ws->mode = MODE_DESCEND;
  bool cacheable_step = !node_has_effectful_top_step(h, chase.end);

  StepOutcome out = step_iterative(slice_id, ws, gas, h, yield_on_gas,
                                   yield_on_step_limit, allow_retry,
                                   step_counter);
  if (cacheable_step && out.type == RESULT_DONE && is_value_ptr(out.val)) {
    bool fixpoint = (out.val == chase.end);
    compress_link_path(links, start, chase.end, out.val, true, hop_limit);
    if (fixpoint) {
      publish_link_ptr(links, out.val, out.val);
    }
  }
  return out;
}

uint32_t arenaKernelStep(uint32_t expr) {
  ensure_arena();
  SabHeader *h = (SabHeader *)ARENA_BASE_ADDR;
  WorkerState ws = {
      .current_val = expr,
      .sp = 0,
      .remaining_steps = 1,
      .mode = MODE_DESCEND,
      .status = WORKER_RUNNING,
      .reserved = 0,
      .req_id = 0,
  };

  if (is_control_ptr(expr)) {
    if (!resume_worker_state(CONTROL_SYNC_SLICE_ID, expr, &ws))
      return expr;
  }

  while (true) {
    uint32_t gas = ARENA_STEP_GAS;
    uint64_t sync_steps = 0;
    StepOutcome o = step_once_with_links(CONTROL_SYNC_SLICE_ID, &ws, &gas, h,
                                         false, false, false, &sync_steps);
    if (o.type == RESULT_YIELD)
      return o.val;
    return o.val;
  }
}

uint32_t reduce(uint32_t expr, uint32_t max) {
  ensure_arena();
  uint32_t limit = (max == 0xffffffff) ? 0xffffffff : max;
  uint32_t cur = expr;
  for (uint32_t i = 0; i < limit; i++) {
    uint32_t next = arenaKernelStep(cur);
    if (next == cur || is_control_ptr(next))
      return next;
    cur = next;
  }
  return cur;
}

__attribute__((no_sanitize("address"))) int64_t hostPullV2(void) {
  if (ARENA_BASE_ADDR == NULL)
    return -1;
  SabHeader *h = (SabHeader *)ARENA_BASE_ADDR;
  uint8_t *base = ARENA_BASE_ADDR;
  Cqe cqe;
  if (try_dequeue((Ring *)(base + h->offset_cq), &cqe, sizeof(Cqe))) {
    uint32_t event = cqe.event_kind & 0x3;
    uint32_t node =
        is_control_ptr(cqe.node_id) ? control_index(cqe.node_id) : cqe.node_id;
    uint32_t packed_low = (event << 30) | node;
    return ((int64_t)cqe.req_id << 32) | (int64_t)packed_low;
  }
  return -1;
}

__attribute__((no_sanitize("address"))) void hostCqDequeueBlocking(Cqe *cqe) {
  if (ARENA_BASE_ADDR == NULL || cqe == NULL)
    return;
  SabHeader *h = (SabHeader *)ARENA_BASE_ADDR;
  Ring *cq = (Ring *)(ARENA_BASE_ADDR + h->offset_cq);
  dequeue_blocking(cq, cqe, sizeof(Cqe));
}

__attribute__((no_sanitize("address"))) void
arena_cq_enqueue_shutdown_sentinel(void) {
  if (ARENA_BASE_ADDR == NULL)
    return;
  SabHeader *h = (SabHeader *)ARENA_BASE_ADDR;
  Ring *cq = (Ring *)(ARENA_BASE_ADDR + h->offset_cq);
  Cqe sentinel = {0, 0, CQ_EVENT_DONE};
  enqueue_blocking(cq, &sentinel, sizeof(Cqe));
}

uint32_t hostSubmit(uint32_t node_id, uint32_t req_id, uint32_t max_steps) {
  ensure_arena();
  if (ARENA_BASE_ADDR == NULL)
    return 2;
  SabHeader *h = (SabHeader *)ARENA_BASE_ADDR;
  Sqe sqe = {node_id, req_id, max_steps};
  if (try_enqueue((Ring *)(ARENA_BASE_ADDR + h->offset_sq), &sqe, sizeof(Sqe)))
    return 0;
  return 1;
}

void arena_stdin_push(uint8_t byte) {
  ensure_arena();
  if (ARENA_BASE_ADDR == NULL)
    return;
  SabHeader *h = (SabHeader *)ARENA_BASE_ADDR;
  enqueue_blocking((Ring *)(ARENA_BASE_ADDR + h->offset_stdin), &byte, 1);
}

bool arena_stdout_try_pop(uint8_t *byte_out) {
  ensure_arena();
  if (ARENA_BASE_ADDR == NULL || byte_out == NULL)
    return false;
  SabHeader *h = (SabHeader *)ARENA_BASE_ADDR;
  return try_dequeue((Ring *)(ARENA_BASE_ADDR + h->offset_stdout), byte_out, 1);
}

bool arena_stdin_wait_try_dequeue(uint32_t *node_id_out) {
  ensure_arena();
  if (ARENA_BASE_ADDR == NULL || node_id_out == NULL)
    return false;
  SabHeader *h = (SabHeader *)ARENA_BASE_ADDR;
  return try_dequeue((Ring *)(ARENA_BASE_ADDR + h->offset_stdin_wait),
                     node_id_out, 4);
}

bool arena_stdout_wait_try_dequeue(uint32_t *node_id_out) {
  ensure_arena();
  if (ARENA_BASE_ADDR == NULL || node_id_out == NULL)
    return false;
  SabHeader *h = (SabHeader *)ARENA_BASE_ADDR;
  return try_dequeue((Ring *)(ARENA_BASE_ADDR + h->offset_stdout_wait),
                     node_id_out, 4);
}

void arena_debug_ring_occupancy(uint32_t *out_sq_count, uint32_t *out_cq_count) {
  ensure_arena();
  if (out_sq_count)
    *out_sq_count = 0;
  if (out_cq_count)
    *out_cq_count = 0;
  if (ARENA_BASE_ADDR == NULL)
    return;

  SabHeader *h = (SabHeader *)ARENA_BASE_ADDR;
  Ring *sq = (Ring *)(ARENA_BASE_ADDR + h->offset_sq);
  Ring *cq = (Ring *)(ARENA_BASE_ADDR + h->offset_cq);
  if (out_sq_count) {
    uint32_t head = atomic_load_explicit(&sq->head, memory_order_acquire);
    uint32_t tail = atomic_load_explicit(&sq->tail, memory_order_acquire);
    *out_sq_count = tail - head;
  }
  if (out_cq_count) {
    uint32_t head = atomic_load_explicit(&cq->head, memory_order_acquire);
    uint32_t tail = atomic_load_explicit(&cq->tail, memory_order_acquire);
    *out_cq_count = tail - head;
  }
}

void workerLoop(uint32_t worker_id) {
  ensure_arena();
  SabHeader *h = (SabHeader *)ARENA_BASE_ADDR;
  Ring *sq = (Ring *)(ARENA_BASE_ADDR + h->offset_sq);
  Ring *cq = (Ring *)(ARENA_BASE_ADDR + h->offset_cq);
  uint32_t batch_gas = ARENA_STEP_GAS;
  const bool use_qsbr = (worker_id < MAX_WORKERS);
  uint64_t worker_steps = 0;
  uint32_t last_req_id = 0;

  while (true) {
    WorkerState idle_ws = {
        .current_val = EMPTY,
        .sp = 0,
        .remaining_steps = 0,
        .mode = MODE_DESCEND,
        .status = WORKER_IDLE,
        .reserved = 0,
        .req_id = last_req_id,
    };
    trace_publish_live(worker_id, &idle_ws, worker_steps);
    Sqe job;
    dequeue_blocking(sq, &job, sizeof(Sqe));

    /* QSBR fast path: register epoch; step_* read current capacity from header.
     */
    if (use_qsbr) {
      uint32_t current_epoch =
          atomic_load_explicit(&h->global_epoch, memory_order_acquire);
      atomic_store_explicit(&h->worker_epochs[worker_id], current_epoch,
                            memory_order_release);
      tls_worker_id = worker_id;
    }

    WorkerState ws = {
        .current_val = job.node_id,
        .sp = 0,
        .remaining_steps =
            (job.max_steps == 0xffffffffu) ? 0xffffffffu : job.max_steps,
        .mode = MODE_DESCEND,
        .status = WORKER_RUNNING,
        .reserved = 0,
        .req_id = job.req_id,
    };

    last_req_id = job.req_id;
    trace_publish_live(worker_id, &ws, worker_steps);

    if (is_control_ptr(job.node_id)) {
      if (!resume_worker_state(worker_id, job.node_id, &ws)) {
        Cqe error = {job.node_id, job.req_id, CQ_EVENT_ERROR};
        if (use_qsbr)
          atomic_store_explicit(&h->worker_epochs[worker_id], 0,
                                memory_order_release);
        enqueue_blocking(cq, &error, sizeof(Cqe));
        if (use_qsbr) {
          tls_worker_id = MAX_WORKERS;
        }
        continue;
      }
    } else {
      ws.current_val = job.node_id;
    }

    trace_publish_live(worker_id, &ws, worker_steps);
    trace_record_event(worker_id, worker_steps, job.req_id,
                       is_control_ptr(job.node_id) ? TRACE_EV_JOB_RESUME
                                                   : TRACE_EV_JOB_START,
                       job.node_id, job.max_steps, 0);

    while (true) {
      if (ws.remaining_steps == 0) {
        StepOutcome budget =
            park_budget_yield(worker_id, &ws, SUSP_STEP_LIMIT, true);
        Cqe result = {budget.val, job.req_id, CQ_EVENT_YIELD};
        if (use_qsbr)
          atomic_store_explicit(&h->worker_epochs[worker_id], 0,
                                memory_order_release);
        enqueue_blocking(cq, &result, sizeof(Cqe));
        break;
      }
      uint32_t before = ws.current_val;
      uint32_t gas = batch_gas;
      StepOutcome o = step_once_with_links(worker_id, &ws, &gas, h, true, true,
                                           true, &worker_steps);
      if (o.type == RESULT_YIELD) {
        uint32_t reason = controlSuspensionReason(o.val);
        uint32_t event;
        if (reason == SUSP_WAIT_IO_STDIN || reason == SUSP_WAIT_IO_STDOUT) {
          event = CQ_EVENT_IO_WAIT;
        } else if (reason == SUSP_IO_EOF || reason == SUSP_IO_ERROR) {
          event = CQ_EVENT_ERROR;
        } else {
          event = CQ_EVENT_YIELD;
        }
        trace_record_event(worker_id, worker_steps, job.req_id,
                           event == CQ_EVENT_IO_WAIT
                               ? TRACE_EV_IO_WAIT
                               : (reason == SUSP_STEP_LIMIT ? TRACE_EV_STEP_LIMIT
                                                            : TRACE_EV_PARK),
                           o.val, reason, ws.current_val);
        Cqe res = {o.val, job.req_id, event};
        if (use_qsbr)
          atomic_store_explicit(&h->worker_epochs[worker_id], 0,
                                memory_order_release);
        enqueue_blocking(cq, &res, sizeof(Cqe));
        break;
      }
      if (o.val == before) {
        trace_record_event(worker_id, worker_steps, job.req_id, TRACE_EV_DONE,
                           o.val, before, 0);
        Cqe res = {o.val, job.req_id, CQ_EVENT_DONE};
        if (use_qsbr)
          atomic_store_explicit(&h->worker_epochs[worker_id], 0,
                                memory_order_release);
        enqueue_blocking(cq, &res, sizeof(Cqe));
        break;
      }
      ws.current_val = o.val;
      ws.sp = 0;
      ws.mode = MODE_DESCEND;
    }

    /* Quiescent state: no longer touching the arena. */
    if (use_qsbr) {
      atomic_store_explicit(&h->worker_epochs[worker_id], 0, memory_order_release);
      tls_worker_id = MAX_WORKERS;
    }
  }
}

uint32_t debugGetArenaBaseAddr(void) {
  return (uint32_t)(uintptr_t)ARENA_BASE_ADDR;
}
uint32_t getArenaMode(void) { return ARENA_MODE; }
uint32_t debugCalculateArenaSize(uint32_t capacity) {
  uint64_t size = calculate_layout(capacity, capacity).total_size;
  return (uint32_t)(size > (uint64_t)(uint32_t)-1 ? (uint32_t)-1 : size);
}
uint32_t debugLockState(void) {
  ensure_arena();
  SabHeader *h = (SabHeader *)ARENA_BASE_ADDR;
  return atomic_load_explicit(&h->resize_seq, memory_order_relaxed);
}
uint32_t debugGetRingEntries(void) { return RING_ENTRIES; }
