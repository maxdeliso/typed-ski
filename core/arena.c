#include "arena.h"

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
#include <sched.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#if defined(__linux__)
#include <limits.h>
#include <linux/futex.h>
#include <sys/syscall.h>
#include <unistd.h>
#endif
#endif

static const uint32_t ARENA_MAGIC = 0x534B4941;
static const uint32_t INITIAL_CAP = 1 << 24;
/** Gas per kernel step / worker batch; bounds time per step. */
static const uint32_t ARENA_STEP_GAS = 20000;
static const uint32_t MAX_CAP = 1 << 27;
static const uint32_t RING_ENTRIES = 1 << 16;
static const uint32_t POISON_SEQ = 0xffffffff;

/** QSBR: max worker threads that can register; readers drain before grow(). */
#define MAX_WORKERS 64
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
static atomic_uint WORKER_EPOCHS[MAX_WORKERS];
static atomic_uint GLOBAL_EPOCH;
/** Set by worker at batch start, cleared at batch end; allocators unregister
 * before grow(). */
#ifdef __wasm__
static uint32_t tls_worker_id = MAX_WORKERS;
#else
static _Thread_local uint32_t tls_worker_id = MAX_WORKERS;
#endif

uint8_t *ARENA_BASE_ADDR = NULL;
static uint32_t ARENA_MODE = 0;
static atomic_uint GROW_COUNT = 0;
/** Native only: actual mmap size reserved at init (layout uses uint64_t so no
 * overflow at MAX_CAP). */
static size_t ARENA_RESERVED_BYTES = 0;

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

/** Cached node IDs for True (K) and False (K I); invalidated by reset(). */
static uint32_t TRUE_ID = EMPTY;
static uint32_t FALSE_ID = EMPTY;

/** Canonical U8 node id per byte value; deduplicated across allocU8 calls. */
static atomic_uint U8_CACHE[256];

static inline uint32_t align64(uint32_t x) { return (x + 63) & ~63u; }
static inline uint64_t align64_u64(uint64_t x) {
  return (x + 63) & ~(uint64_t)63;
}

static inline void sys_wait32(atomic_uint *ptr, uint32_t expected) {
#ifdef __wasm__
  __builtin_wasm_memory_atomic_wait32((int *)ptr, (int)expected, -1);
#elif defined(__linux__)
  syscall(SYS_futex, ptr, FUTEX_WAIT_PRIVATE, expected, NULL, NULL, 0);
#else

  while (atomic_load_explicit(ptr, memory_order_acquire) == expected) {
  }
#endif
}

static inline void sys_notify(atomic_uint *ptr, uint32_t count) {
#ifdef __wasm__
  __builtin_wasm_memory_atomic_notify((int *)ptr, count);
#elif defined(__linux__)
  syscall(SYS_futex, ptr, FUTEX_WAKE_PRIVATE, count, NULL, NULL, 0);
#else

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

typedef struct {
  uint32_t current_val;
  uint32_t sp;
  uint32_t remaining_steps;
  uint8_t mode;
  uint8_t status;
  uint16_t reserved;
} WorkerState;

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

static inline uint8_t load_u8_payload(atomic_uchar *arr, uint32_t n) {
  return atomic_load_explicit(&arr[n], memory_order_relaxed);
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
static SabLayout calculate_layout(uint32_t capacity) {
  SabLayout l;
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
  /* Invariant offsets: partition the reserved MAX_CAP space immediately. */
  l.offset_node_left =
      (uint64_t)align64(l.offset_term_cache + TERM_CACHE_LEN * 4);
  l.offset_node_right = align64_u64(l.offset_node_left + (uint64_t)MAX_CAP * 4);
  l.offset_node_hash32 =
      align64_u64(l.offset_node_right + (uint64_t)MAX_CAP * 4);
  l.offset_node_next_idx =
      align64_u64(l.offset_node_hash32 + (uint64_t)MAX_CAP * 4);
  l.offset_node_kind =
      align64_u64(l.offset_node_next_idx + (uint64_t)MAX_CAP * 4);
  l.offset_node_sym = align64_u64(l.offset_node_kind + (uint64_t)MAX_CAP * 1);
  /* Buckets follow the node arrays. */
  l.offset_buckets = align64_u64(l.offset_node_sym + (uint64_t)MAX_CAP * 1);
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

static void *allocate_raw_arena(uint32_t capacity) {
  SabLayout layout = calculate_layout(capacity);
#ifdef __wasm__
  uint32_t pages_needed =
      (uint32_t)((layout.total_size + WASM_PAGE_SIZE - 1) / WASM_PAGE_SIZE);
  int old_pages = __builtin_wasm_memory_grow(0, pages_needed);
  if (old_pages == -1)
    return NULL;
  ARENA_BASE_ADDR = (uint8_t *)((uintptr_t)old_pages * WASM_PAGE_SIZE);
#else

  SabLayout reserve_layout = calculate_layout(MAX_CAP);
  ARENA_RESERVED_BYTES = (size_t)reserve_layout.total_size;
  fprintf(stderr,
          "Arena: reserving %zu bytes (active=%zu for capacity %u), "
          "sizeof(SabHeader)=%zu\n",
          ARENA_RESERVED_BYTES, (size_t)layout.total_size, capacity,
          sizeof(SabHeader));
  ARENA_BASE_ADDR =
      (uint8_t *)mmap(NULL, ARENA_RESERVED_BYTES, PROT_READ | PROT_WRITE,
                      MAP_ANONYMOUS | MAP_SHARED, -1, 0);
  if (ARENA_BASE_ADDR == MAP_FAILED) {
    perror("Arena: mmap failed");
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
  h->offset_node_kind = layout.offset_node_kind;
  h->offset_node_sym = layout.offset_node_sym;
  h->offset_buckets = layout.offset_buckets;

  /* Layout sanity assertions. */
  ARENA_ASSERT(h->offset_node_left < h->offset_node_right);
  ARENA_ASSERT(h->offset_node_right < h->offset_node_hash32);
  ARENA_ASSERT(h->offset_node_hash32 < h->offset_node_next_idx);
  ARENA_ASSERT(h->offset_node_next_idx < h->offset_node_kind);
  ARENA_ASSERT(h->offset_node_kind < h->offset_node_sym);
  ARENA_ASSERT(h->offset_node_sym < h->offset_buckets);
#ifndef __wasm__
  if (ARENA_RESERVED_BYTES > 0) {
    ARENA_ASSERT(layout.total_size <= ARENA_RESERVED_BYTES);
  }
#endif

  atomic_init(&h->capacity, capacity);
  h->bucket_mask = capacity - 1;
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

  memset(ARENA_BASE_ADDR + h->offset_node_left, 0, capacity * 4);
  memset(ARENA_BASE_ADDR + h->offset_node_right, 0, capacity * 4);
  memset(ARENA_BASE_ADDR + h->offset_node_hash32, 0, capacity * 4);
  memset(ARENA_BASE_ADDR + h->offset_node_next_idx, 0, capacity * 4);
  memset(ARENA_BASE_ADDR + h->offset_node_kind, 0, capacity * 1);
  memset(ARENA_BASE_ADDR + h->offset_node_sym, 0, capacity * 1);

  atomic_uint *buckets = (atomic_uint *)(ARENA_BASE_ADDR + h->offset_buckets);
  for (uint32_t i = 0; i < capacity; i++)
    atomic_init(&buckets[i], EMPTY);

  for (uint32_t u = 0; u < 256; u++)
    atomic_init(&U8_CACHE[u], EMPTY);

  atomic_init(&h->total_nodes, 0);
  atomic_init(&h->total_steps, 0);
  atomic_init(&h->total_cons_allocs, 0);
  atomic_init(&h->total_cont_allocs, 0);
  atomic_init(&h->total_susp_allocs, 0);
  atomic_init(&h->duplicate_lost_allocs, 0);
  atomic_init(&h->hashcons_hits, 0);
  atomic_init(&h->hashcons_misses, 0);

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
  allocate_raw_arena(INITIAL_CAP);
  ARENA_MODE = 0;
}

uint32_t initArena(uint32_t initial_capacity) {
  if (initial_capacity < 1024 || initial_capacity > MAX_CAP ||
      (initial_capacity & (initial_capacity - 1)) != 0) {
    return 0;
  }
  if (ARENA_BASE_ADDR != NULL)
    return (uint32_t)(uintptr_t)ARENA_BASE_ADDR;
  /* One-time QSBR init */
  static bool qsbr_inited = false;
  if (!qsbr_inited) {
    atomic_init(&GLOBAL_EPOCH, 1);
    for (uint32_t i = 0; i < MAX_WORKERS; i++)
      atomic_init(&WORKER_EPOCHS[i], 0);
    qsbr_inited = true;
  }
  if (!allocate_raw_arena(initial_capacity))
    return 1;
  ARENA_MODE = 1;
  return (uint32_t)(uintptr_t)ARENA_BASE_ADDR;
}

uint32_t connectArena(uint32_t ptr_addr) {
  if (ptr_addr == 0 || ptr_addr % 64 != 0)
    return 0;
  ARENA_BASE_ADDR = (uint8_t *)(uintptr_t)ptr_addr;
  ARENA_MODE = 1;
  SabHeader *h = (SabHeader *)ARENA_BASE_ADDR;
  if (h->magic != ARENA_MAGIC)
    return 5;

  TRUE_ID = EMPTY;
  FALSE_ID = EMPTY;
  atomic_store_explicit(&GROW_COUNT, 0, memory_order_relaxed);

  for (uint32_t u = 0; u < 256; u++)
    atomic_store_explicit(&U8_CACHE[u], EMPTY, memory_order_relaxed);
  return 1;
}

void reset(void) {
  ensure_arena();
  SabHeader *h = (SabHeader *)ARENA_BASE_ADDR;
  atomic_store_explicit(&h->top, 0, memory_order_release);
  atomic_uint *buckets = (atomic_uint *)(ARENA_BASE_ADDR + h->offset_buckets);
  for (uint32_t i = 0;
       i < atomic_load_explicit(&h->capacity, memory_order_relaxed); i++)
    atomic_store_explicit(&buckets[i], EMPTY, memory_order_release);
  atomic_uint *cache = (atomic_uint *)(ARENA_BASE_ADDR + h->offset_term_cache);
  for (uint32_t i = 0; i < TERM_CACHE_LEN; i++)
    atomic_store_explicit(&cache[i], EMPTY, memory_order_release);
  control_init_at(h);
  atomic_store_explicit(&GROW_COUNT, 0, memory_order_release);
  TRUE_ID = EMPTY;
  FALSE_ID = EMPTY;
  for (uint32_t u = 0; u < 256; u++)
    atomic_store_explicit(&U8_CACHE[u], EMPTY, memory_order_release);

  atomic_store_explicit(&h->total_nodes, 0, memory_order_release);
  atomic_store_explicit(&h->total_steps, 0, memory_order_release);
  atomic_store_explicit(&h->total_cons_allocs, 0, memory_order_release);
  atomic_store_explicit(&h->total_cont_allocs, 0, memory_order_release);
  atomic_store_explicit(&h->total_susp_allocs, 0, memory_order_release);
  atomic_store_explicit(&h->duplicate_lost_allocs, 0, memory_order_release);
  atomic_store_explicit(&h->hashcons_hits, 0, memory_order_release);
  atomic_store_explicit(&h->hashcons_misses, 0, memory_order_release);

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
        atomic_store_explicit(&WORKER_EPOCHS[tls_worker_id], 0,
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
            atomic_load_explicit(&GLOBAL_EPOCH, memory_order_acquire);
        atomic_store_explicit(&WORKER_EPOCHS[tls_worker_id], cur_epoch,
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
        atomic_store_explicit(&WORKER_EPOCHS[tls_worker_id], 0,
                              memory_order_release);
        grow();
        uint32_t cur_epoch =
            atomic_load_explicit(&GLOBAL_EPOCH, memory_order_acquire);
        atomic_store_explicit(&WORKER_EPOCHS[tls_worker_id], cur_epoch,
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

uint32_t allocU8(uint8_t value) {
  ensure_arena();

  uint32_t cached =
      atomic_load_explicit(&U8_CACHE[value], memory_order_acquire);
  if (cached != EMPTY)
    return cached;

  while (true) {
    SabHeader *h;
    uint32_t seq = enter_stable(&h);

    uint32_t id = atomic_fetch_add_explicit(&h->top, 1, memory_order_acq_rel);
    atomic_fetch_add_explicit(&h->total_nodes, 1, memory_order_relaxed);
    if (id >= atomic_load_explicit(&h->capacity, memory_order_relaxed)) {
      if (tls_worker_id < MAX_WORKERS) {
        atomic_store_explicit(&WORKER_EPOCHS[tls_worker_id], 0,
                              memory_order_release);
        grow();
        uint32_t cur_epoch =
            atomic_load_explicit(&GLOBAL_EPOCH, memory_order_acquire);
        atomic_store_explicit(&WORKER_EPOCHS[tls_worker_id], cur_epoch,
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
    if (atomic_compare_exchange_strong_explicit(&U8_CACHE[value], &expected, id,
                                                memory_order_release,
                                                memory_order_relaxed))
      return id;
    return atomic_load_explicit(&U8_CACHE[value], memory_order_acquire);
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
        atomic_store_explicit(&WORKER_EPOCHS[tls_worker_id], 0,
                              memory_order_release);
        grow();
        uint32_t cur_epoch =
            atomic_load_explicit(&GLOBAL_EPOCH, memory_order_acquire);
        atomic_store_explicit(&WORKER_EPOCHS[tls_worker_id], cur_epoch,
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
    atomic_uint *next_idxs =
        (atomic_uint *)(ARENA_BASE_ADDR + h->offset_node_next_idx);
    atomic_uint *buckets = (atomic_uint *)(ARENA_BASE_ADDR + h->offset_buckets);

    atomic_store_explicit(&lefts[id], l, memory_order_relaxed);
    atomic_store_explicit(&rights[id], r, memory_order_relaxed);
    atomic_store_explicit(&hashes[id], hval, memory_order_relaxed);
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
  atomic_uint *gate = &GLOBAL_EPOCH;
  uint32_t observed = atomic_load_explicit(gate, memory_order_relaxed);
  __builtin_wasm_memory_atomic_wait32((int *)gate, (int)observed, 0);
#elif defined(__linux__)
  sched_yield();
#else
  (void)0;
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
      atomic_fetch_add_explicit(&GLOBAL_EPOCH, 1, memory_order_acq_rel) + 1;
  for (uint32_t i = 0; i < MAX_WORKERS; i++) {
    while (true) {
      uint32_t w_epoch =
          atomic_load_explicit(&WORKER_EPOCHS[i], memory_order_acquire);
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

  if (old_cap >= MAX_CAP ||
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
  if (new_cap > MAX_CAP)
    new_cap = MAX_CAP;
#ifndef __wasm__
  /* Cap so we never write past the actual mmap (defense-in-depth). */
  if (ARENA_RESERVED_BYTES > 0) {
    while (new_cap > old_cap) {
      SabLayout probe = calculate_layout(new_cap);
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
      atomic_fetch_add_explicit(&GROW_COUNT, 1, memory_order_relaxed) + 1;
#ifndef __wasm__
  fprintf(stderr, "Arena: grow #%u %u -> %u (top=%u)\n", grow_num, old_cap,
          new_cap, old_top);
#else
  (void)grow_num;
#endif

  SabLayout layout = calculate_layout(new_cap);

#ifdef __wasm__
  uint32_t current_bytes = __builtin_wasm_memory_size(0) * WASM_PAGE_SIZE;
  uintptr_t needed_end =
      (uintptr_t)ARENA_BASE_ADDR + (uintptr_t)layout.total_size;
  if (needed_end > current_bytes) {
    uint32_t extra = needed_end - current_bytes;
    uint32_t pages = (extra + WASM_PAGE_SIZE - 1) / WASM_PAGE_SIZE;
    if (__builtin_wasm_memory_grow(0, pages) == -1) {
      atomic_store_explicit(&h->resize_seq, POISON_SEQ, memory_order_release);
      __builtin_trap();
    }
  }
#else

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
  h->offset_node_kind = layout.offset_node_kind;
  h->offset_node_sym = layout.offset_node_sym;
  h->offset_buckets = layout.offset_buckets;

  /* Layout sanity assertions. */
  ARENA_ASSERT(h->offset_node_left < h->offset_node_right);
  ARENA_ASSERT(h->offset_node_right < h->offset_node_hash32);
  ARENA_ASSERT(h->offset_node_hash32 < h->offset_node_next_idx);
  ARENA_ASSERT(h->offset_node_next_idx < h->offset_node_kind);
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
  if (TRUE_ID == EMPTY) {
    TRUE_ID = allocTerminal(ARENA_SYM_K);
  }
  return TRUE_ID;
}

/** Prelude false = (K I) */
static uint32_t arenaFalse(void) {
  if (FALSE_ID == EMPTY) {
    uint32_t k = allocTerminal(ARENA_SYM_K);
    uint32_t i = allocTerminal(ARENA_SYM_I);
    FALSE_ID = allocCons(k, i);
  }
  return FALSE_ID;
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
    atomic_store_explicit(&WORKER_EPOCHS[tls_worker_id], 0,
                          memory_order_release);
  }
  enqueue_blocking((Ring *)(ARENA_BASE_ADDR + wait_offset), &susp_ptr, 4);
  out->type = RESULT_YIELD;
  out->val = susp_ptr;
  return true;
}

static StepOutcome step_iterative(uint32_t slice_id, WorkerState *ws,
                                  uint32_t *gas, SabHeader *h,
                                  bool yield_on_gas, bool yield_on_step_limit,
                                  bool allow_retry) {
  ControlViews cv = control_views();
  StepOutcome out = {RESULT_DONE, EMPTY};

  atomic_uchar *kinds = (atomic_uchar *)(ARENA_BASE_ADDR + h->offset_node_kind);
  atomic_uchar *syms = (atomic_uchar *)(ARENA_BASE_ADDR + h->offset_node_sym);
  atomic_uint *lefts = (atomic_uint *)(ARENA_BASE_ADDR + h->offset_node_left);
  atomic_uint *rights = (atomic_uint *)(ARENA_BASE_ADDR + h->offset_node_right);

  while (true) {
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

    worker_push_frame(cv, slice_id, ws,
                      (Frame){FRAME_UPDATE, STAGE_LEFT, 0, ws->current_val, 0});
    ws->current_val = left;
    ws->mode = MODE_DESCEND;
  }
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
  };

  if (is_control_ptr(expr)) {
    if (!resume_worker_state(CONTROL_SYNC_SLICE_ID, expr, &ws))
      return expr;
  }

  while (true) {
    uint32_t gas = ARENA_STEP_GAS;
    StepOutcome o = step_iterative(CONTROL_SYNC_SLICE_ID, &ws, &gas, h, false,
                                   false, false);
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

void workerLoop(uint32_t worker_id) {
  ensure_arena();
  SabHeader *h = (SabHeader *)ARENA_BASE_ADDR;
  Ring *sq = (Ring *)(ARENA_BASE_ADDR + h->offset_sq);
  Ring *cq = (Ring *)(ARENA_BASE_ADDR + h->offset_cq);
  uint32_t batch_gas = ARENA_STEP_GAS;
  const bool use_qsbr = (worker_id < MAX_WORKERS);

  while (true) {
    Sqe job;
    dequeue_blocking(sq, &job, sizeof(Sqe));

    /* QSBR fast path: register epoch; step_* read current capacity from header.
     */
    if (use_qsbr) {
      uint32_t current_epoch =
          atomic_load_explicit(&GLOBAL_EPOCH, memory_order_acquire);
      atomic_store_explicit(&WORKER_EPOCHS[worker_id], current_epoch,
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
    };

    if (is_control_ptr(job.node_id)) {
      if (!resume_worker_state(worker_id, job.node_id, &ws)) {
        Cqe error = {job.node_id, job.req_id, CQ_EVENT_ERROR};
        if (use_qsbr)
          atomic_store_explicit(&WORKER_EPOCHS[worker_id], 0,
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

    while (true) {
      if (ws.remaining_steps == 0) {
        StepOutcome budget =
            park_budget_yield(worker_id, &ws, SUSP_STEP_LIMIT, true);
        Cqe result = {budget.val, job.req_id, CQ_EVENT_YIELD};
        if (use_qsbr)
          atomic_store_explicit(&WORKER_EPOCHS[worker_id], 0,
                                memory_order_release);
        enqueue_blocking(cq, &result, sizeof(Cqe));
        break;
      }
      uint32_t before = ws.current_val;
      uint32_t gas = batch_gas;
      StepOutcome o = step_iterative(worker_id, &ws, &gas, h, true, true, true);
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
        Cqe res = {o.val, job.req_id, event};
        if (use_qsbr)
          atomic_store_explicit(&WORKER_EPOCHS[worker_id], 0,
                                memory_order_release);
        enqueue_blocking(cq, &res, sizeof(Cqe));
        break;
      }
      if (o.val == before) {
        Cqe res = {o.val, job.req_id, CQ_EVENT_DONE};
        if (use_qsbr)
          atomic_store_explicit(&WORKER_EPOCHS[worker_id], 0,
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
      atomic_store_explicit(&WORKER_EPOCHS[worker_id], 0, memory_order_release);
      tls_worker_id = MAX_WORKERS;
    }
  }
}

uint32_t debugGetArenaBaseAddr(void) {
  return (uint32_t)(uintptr_t)ARENA_BASE_ADDR;
}
uint32_t getArenaMode(void) { return ARENA_MODE; }
uint32_t debugCalculateArenaSize(uint32_t capacity) {
  uint64_t size = calculate_layout(capacity).total_size;
  return (uint32_t)(size > (uint64_t)(uint32_t)-1 ? (uint32_t)-1 : size);
}
uint32_t debugLockState(void) {
  ensure_arena();
  SabHeader *h = (SabHeader *)ARENA_BASE_ADDR;
  return atomic_load_explicit(&h->resize_seq, memory_order_relaxed);
}
uint32_t debugGetRingEntries(void) { return RING_ENTRIES; }
