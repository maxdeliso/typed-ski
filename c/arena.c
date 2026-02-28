#define _GNU_SOURCE
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

uint8_t *ARENA_BASE_ADDR = NULL;
static uint32_t ARENA_MODE = 0;
static atomic_uint GROW_COUNT = 0;

/** Cached node IDs for True (K) and False (K I); invalidated by reset(). */
static uint32_t TRUE_ID = EMPTY;
static uint32_t FALSE_ID = EMPTY;

/** Canonical U8 node id per byte value; deduplicated across allocU8 calls. */
static atomic_uint U8_CACHE[256];

static inline uint32_t align64(uint32_t x) { return (x + 63) & ~63; }

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
  atomic_init(&ring->not_full, entries);
  ring->entries = entries;
  ring->mask = entries - 1;
  for (uint32_t i = 0; i < entries; i++) {
    SlotHeader *slot = (SlotHeader *)GET_SLOT(ring, i, slot_size);
    atomic_init(&slot->seq, i);
  }
}

typedef struct {
  uint32_t offset_sq;
  uint32_t offset_cq;
  uint32_t offset_stdin;
  uint32_t offset_stdout;
  uint32_t offset_stdin_wait;
  uint32_t offset_stdout_wait;
  uint32_t offset_kind;
  uint32_t offset_sym;
  uint32_t offset_left_id;
  uint32_t offset_right_id;
  uint32_t offset_hash32;
  uint32_t offset_next_idx;
  uint32_t offset_buckets;
  uint32_t offset_term_cache;
  uint32_t total_size;
} SabLayout;

static SabLayout calculate_layout(uint32_t capacity) {
  SabLayout l;
  l.offset_sq = align64(sizeof(SabHeader));
  l.offset_cq = align64(l.offset_sq + ring_bytes(RING_ENTRIES, sizeof(Sqe)));
  l.offset_stdin = align64(l.offset_cq + ring_bytes(RING_ENTRIES, sizeof(Cqe)));
  l.offset_stdout = align64(l.offset_stdin + ring_bytes(RING_ENTRIES, 1));
  l.offset_stdin_wait = align64(l.offset_stdout + ring_bytes(RING_ENTRIES, 1));
  l.offset_stdout_wait =
      align64(l.offset_stdin_wait + ring_bytes(RING_ENTRIES, 4));
  l.offset_kind = align64(l.offset_stdout_wait + ring_bytes(RING_ENTRIES, 4));
  l.offset_sym = l.offset_kind + capacity;
  l.offset_left_id = align64(l.offset_sym + capacity);
  l.offset_right_id = l.offset_left_id + 4 * capacity;
  l.offset_hash32 = l.offset_right_id + 4 * capacity;
  l.offset_next_idx = l.offset_hash32 + 4 * capacity;
  l.offset_buckets = align64(l.offset_next_idx + 4 * capacity);
  l.offset_term_cache = l.offset_buckets + 4 * capacity;
  l.total_size = l.offset_term_cache + TERM_CACHE_LEN * 4;
  return l;
}

static void *allocate_raw_arena(uint32_t capacity) {
  SabLayout layout = calculate_layout(capacity);
#ifdef __wasm__
  uint32_t pages_needed =
      (layout.total_size + WASM_PAGE_SIZE - 1) / WASM_PAGE_SIZE;
  int old_pages = __builtin_wasm_memory_grow(0, pages_needed);
  if (old_pages == -1)
    return NULL;
  ARENA_BASE_ADDR = (uint8_t *)((uintptr_t)old_pages * WASM_PAGE_SIZE);
#else

  SabLayout reserve_layout = calculate_layout(MAX_CAP);
  fprintf(stderr,
          "Arena: reserving %u bytes (active=%u for capacity %u), "
          "sizeof(SabHeader)=%zu\n",
          reserve_layout.total_size, layout.total_size, capacity,
          sizeof(SabHeader));
  ARENA_BASE_ADDR =
      (uint8_t *)mmap(NULL, reserve_layout.total_size, PROT_READ | PROT_WRITE,
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
  h->offset_kind = layout.offset_kind;
  h->offset_sym = layout.offset_sym;
  h->offset_left_id = layout.offset_left_id;
  h->offset_right_id = layout.offset_right_id;
  h->offset_hash32 = layout.offset_hash32;
  h->offset_next_idx = layout.offset_next_idx;
  h->offset_buckets = layout.offset_buckets;
  h->offset_term_cache = layout.offset_term_cache;
  h->capacity = capacity;
  h->bucket_mask = capacity - 1;
  atomic_init(&h->resize_seq, 0);
  atomic_init(&h->top, 0);

  ring_init_at(ARENA_BASE_ADDR + h->offset_sq, RING_ENTRIES, sizeof(Sqe));
  ring_init_at(ARENA_BASE_ADDR + h->offset_cq, RING_ENTRIES, sizeof(Cqe));
  ring_init_at(ARENA_BASE_ADDR + h->offset_stdin, RING_ENTRIES, 1);
  ring_init_at(ARENA_BASE_ADDR + h->offset_stdout, RING_ENTRIES, 1);
  ring_init_at(ARENA_BASE_ADDR + h->offset_stdin_wait, RING_ENTRIES, 4);
  ring_init_at(ARENA_BASE_ADDR + h->offset_stdout_wait, RING_ENTRIES, 4);

  atomic_uint *buckets = (atomic_uint *)(ARENA_BASE_ADDR + h->offset_buckets);
  for (uint32_t i = 0; i < capacity; i++)
    atomic_init(&buckets[i], EMPTY);

  atomic_uint *cache = (atomic_uint *)(ARENA_BASE_ADDR + h->offset_term_cache);
  for (uint32_t i = 0; i < TERM_CACHE_LEN; i++)
    atomic_init(&cache[i], EMPTY);

  for (uint32_t u = 0; u < 256; u++)
    atomic_init(&U8_CACHE[u], EMPTY);

  return ARENA_BASE_ADDR;
}

void ensure_arena(void) {
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
  for (uint32_t i = 0; i < h->capacity; i++)
    atomic_store_explicit(&buckets[i], EMPTY, memory_order_release);
  atomic_uint *cache = (atomic_uint *)(ARENA_BASE_ADDR + h->offset_term_cache);
  for (uint32_t i = 0; i < TERM_CACHE_LEN; i++)
    atomic_store_explicit(&cache[i], EMPTY, memory_order_release);
  atomic_store_explicit(&GROW_COUNT, 0, memory_order_release);
  TRUE_ID = EMPTY;
  FALSE_ID = EMPTY;
  for (uint32_t u = 0; u < 256; u++)
    atomic_store_explicit(&U8_CACHE[u], EMPTY, memory_order_release);
  atomic_store_explicit(
      &h->resize_seq,
      atomic_load_explicit(&h->resize_seq, memory_order_relaxed) & ~1,
      memory_order_release);
}

#undef kindOf
uint32_t kindOf(uint32_t n) { return kindOf_inline(n); }
#undef symOf
uint32_t symOf(uint32_t n) { return symOf_inline(n); }
#undef hashOf
uint32_t hashOf(uint32_t n) { return hashOf_inline(n); }
#undef leftOf
uint32_t leftOf(uint32_t n) { return leftOf_inline(n); }
#undef rightOf
uint32_t rightOf(uint32_t n) { return rightOf_inline(n); }

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
    if (id >= h->capacity) {
      grow();
      continue;
    }

    atomic_uchar *kind = (atomic_uchar *)(ARENA_BASE_ADDR + h->offset_kind);
    atomic_uchar *sym_arr = (atomic_uchar *)(ARENA_BASE_ADDR + h->offset_sym);
    atomic_uint *hash_arr = (atomic_uint *)(ARENA_BASE_ADDR + h->offset_hash32);

    atomic_store_explicit(&sym_arr[id], (uint8_t)sym, memory_order_release);
    atomic_store_explicit(&hash_arr[id], sym, memory_order_release);
    atomic_store_explicit(&kind[id], ARENA_KIND_TERMINAL, memory_order_release);

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
    if (id >= h->capacity) {
      grow();
      continue;
    }

    atomic_uchar *kind = (atomic_uchar *)(ARENA_BASE_ADDR + h->offset_kind);
    atomic_uchar *sym_arr = (atomic_uchar *)(ARENA_BASE_ADDR + h->offset_sym);
    atomic_uint *hash_arr = (atomic_uint *)(ARENA_BASE_ADDR + h->offset_hash32);
    atomic_uint *left_arr =
        (atomic_uint *)(ARENA_BASE_ADDR + h->offset_left_id);
    atomic_uint *right_arr =
        (atomic_uint *)(ARENA_BASE_ADDR + h->offset_right_id);

    atomic_store_explicit(&sym_arr[id], value, memory_order_relaxed);
    atomic_store_explicit(&hash_arr[id], (uint32_t)value, memory_order_relaxed);
    atomic_store_explicit(&left_arr[id], EMPTY, memory_order_relaxed);
    atomic_store_explicit(&right_arr[id], EMPTY, memory_order_relaxed);
    atomic_store_explicit(&kind[id], ARENA_KIND_U8, memory_order_release);

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

static inline uint32_t avalanche32(uint32_t x) {
  x ^= x >> 16;
  x *= 0x7feb352d;
  x ^= x >> 15;
  x *= 0x846ca68b;
  x ^= x >> 16;
  return x;
}

static inline uint32_t mix(uint32_t a, uint32_t b) {
  return avalanche32(a ^ (b * 0x9e3779b9));
}

uint32_t allocCons(uint32_t l, uint32_t r) {
  ensure_arena();

  uint32_t hl, hr;
  while (true) {
    SabHeader *head;
    uint32_t seq = enter_stable(&head);
    if (l >= head->capacity)
      return EMPTY;
    atomic_uint *hashes =
        (atomic_uint *)(ARENA_BASE_ADDR + head->offset_hash32);
    hl = atomic_load_explicit(&hashes[l], memory_order_acquire);
    atomic_thread_fence(memory_order_acquire);
    if (check_stable(seq))
      break;
  }
  while (true) {
    SabHeader *head;
    uint32_t seq = enter_stable(&head);
    if (r >= head->capacity)
      return EMPTY;
    atomic_uint *hashes =
        (atomic_uint *)(ARENA_BASE_ADDR + head->offset_hash32);
    hr = atomic_load_explicit(&hashes[r], memory_order_acquire);
    atomic_thread_fence(memory_order_acquire);
    if (check_stable(seq))
      break;
  }
  uint32_t hval = mix(hl, hr);

  uint32_t bucket_idx;
  while (true) {
    SabHeader *head;
    uint32_t seq = enter_stable(&head);
    bucket_idx = hval & head->bucket_mask;
    if (bucket_idx >= head->capacity)
      continue;

    atomic_uint *buckets =
        (atomic_uint *)(ARENA_BASE_ADDR + head->offset_buckets);
    atomic_uint *next =
        (atomic_uint *)(ARENA_BASE_ADDR + head->offset_next_idx);
    atomic_uchar *kind = (atomic_uchar *)(ARENA_BASE_ADDR + head->offset_kind);
    atomic_uint *hashes =
        (atomic_uint *)(ARENA_BASE_ADDR + head->offset_hash32);
    atomic_uint *left = (atomic_uint *)(ARENA_BASE_ADDR + head->offset_left_id);
    atomic_uint *right =
        (atomic_uint *)(ARENA_BASE_ADDR + head->offset_right_id);

    uint32_t cur =
        atomic_load_explicit(&buckets[bucket_idx], memory_order_acquire);
    uint32_t found = EMPTY;

    while (cur != EMPTY) {
      if (cur >= head->capacity)
        break;
      if (atomic_load_explicit(&kind[cur], memory_order_acquire) ==
          ARENA_KIND_NON_TERM) {
        if (atomic_load_explicit(&hashes[cur], memory_order_acquire) == hval &&
            atomic_load_explicit(&left[cur], memory_order_acquire) == l &&
            atomic_load_explicit(&right[cur], memory_order_acquire) == r) {
          found = cur;
          break;
        }
      }
      cur = atomic_load_explicit(&next[cur], memory_order_acquire);
    }

    if (check_stable(seq)) {
      if (found != EMPTY)
        return found;
      break;
    }
  }

  while (true) {
    SabHeader *h;
    uint32_t seq = enter_stable(&h);
    uint32_t b = hval & h->bucket_mask;
    uint32_t id = atomic_fetch_add_explicit(&h->top, 1, memory_order_acq_rel);
    if (id >= h->capacity) {
      grow();
      continue;
    }

    atomic_uchar *kind = (atomic_uchar *)(ARENA_BASE_ADDR + h->offset_kind);
    atomic_uint *left = (atomic_uint *)(ARENA_BASE_ADDR + h->offset_left_id);
    atomic_uint *right = (atomic_uint *)(ARENA_BASE_ADDR + h->offset_right_id);
    atomic_uint *hashes = (atomic_uint *)(ARENA_BASE_ADDR + h->offset_hash32);
    atomic_uint *next = (atomic_uint *)(ARENA_BASE_ADDR + h->offset_next_idx);
    atomic_uint *buckets = (atomic_uint *)(ARENA_BASE_ADDR + h->offset_buckets);

    atomic_store_explicit(&left[id], l, memory_order_release);
    atomic_store_explicit(&right[id], r, memory_order_release);
    atomic_store_explicit(&hashes[id], hval, memory_order_release);
    atomic_store_explicit(&kind[id], ARENA_KIND_NON_TERM, memory_order_release);

    if (!check_stable(seq))
      continue;

    while (true) {
      if (!check_stable(seq))
        return id;

      uint32_t head = atomic_load_explicit(&buckets[b], memory_order_acquire);
      atomic_store_explicit(&next[id], head, memory_order_relaxed);
      if (atomic_compare_exchange_weak_explicit(&buckets[b], &head, id,
                                                memory_order_release,
                                                memory_order_relaxed)) {
        return id;
      }

      uint32_t cur2 = atomic_load_explicit(&buckets[b], memory_order_acquire);
      while (cur2 != EMPTY) {
        if (atomic_load_explicit(&kind[cur2], memory_order_acquire) ==
                ARENA_KIND_NON_TERM &&
            atomic_load_explicit(&hashes[cur2], memory_order_acquire) == hval &&
            atomic_load_explicit(&left[cur2], memory_order_acquire) == l &&
            atomic_load_explicit(&right[cur2], memory_order_acquire) == r) {
          atomic_store_explicit(&kind[id], 0, memory_order_release);
          return cur2;
        }
        cur2 = atomic_load_explicit(&next[cur2], memory_order_acquire);
      }
    }
  }
}

static uint32_t alloc_generic(uint8_t kind_val, uint8_t sym_val,
                              uint32_t left_val, uint32_t right_val,
                              uint32_t hash_val) {
  ensure_arena();
  while (true) {
    SabHeader *h;
    uint32_t seq = enter_stable(&h);
    uint32_t id = atomic_fetch_add_explicit(&h->top, 1, memory_order_acq_rel);
    if (id >= h->capacity) {
      grow();
      continue;
    }
    atomic_uchar *kind = (atomic_uchar *)(ARENA_BASE_ADDR + h->offset_kind);
    atomic_uchar *sym_arr = (atomic_uchar *)(ARENA_BASE_ADDR + h->offset_sym);
    atomic_uint *left = (atomic_uint *)(ARENA_BASE_ADDR + h->offset_left_id);
    atomic_uint *right = (atomic_uint *)(ARENA_BASE_ADDR + h->offset_right_id);
    atomic_uint *hashes = (atomic_uint *)(ARENA_BASE_ADDR + h->offset_hash32);

    atomic_store_explicit(&sym_arr[id], sym_val, memory_order_release);
    atomic_store_explicit(&left[id], left_val, memory_order_release);
    atomic_store_explicit(&right[id], right_val, memory_order_release);
    atomic_store_explicit(&hashes[id], hash_val, memory_order_release);
    atomic_store_explicit(&kind[id], kind_val, memory_order_release);

    if (!check_stable(seq))
      continue;

    return id;
  }
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

  uint32_t old_cap = h->capacity;

  if (old_cap >= MAX_CAP || (old_cap * 2) <= h->capacity) {
    atomic_fetch_add_explicit(&h->resize_seq, 1, memory_order_release);
    return;
  }
  if (atomic_load_explicit(&h->top, memory_order_acquire) < old_cap) {
    atomic_fetch_add_explicit(&h->resize_seq, 1, memory_order_release);
    return;
  }

  uint32_t old_offset_kind = h->offset_kind;
  uint32_t old_offset_sym = h->offset_sym;
  uint32_t old_offset_left = h->offset_left_id;
  uint32_t old_offset_right = h->offset_right_id;
  uint32_t old_offset_hash = h->offset_hash32;
  uint32_t old_offset_next = h->offset_next_idx;
  uint32_t old_offset_term_cache = h->offset_term_cache;
  uint32_t old_top = atomic_load_explicit(&h->top, memory_order_acquire);

  uint32_t new_cap = old_cap * 2;
  if (new_cap > MAX_CAP)
    new_cap = MAX_CAP;
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
  uintptr_t needed_end = (uintptr_t)ARENA_BASE_ADDR + layout.total_size;
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

  h->capacity = new_cap;
  h->bucket_mask = new_cap - 1;
  h->offset_sq = layout.offset_sq;
  h->offset_cq = layout.offset_cq;
  h->offset_stdin = layout.offset_stdin;
  h->offset_stdout = layout.offset_stdout;
  h->offset_stdin_wait = layout.offset_stdin_wait;
  h->offset_stdout_wait = layout.offset_stdout_wait;
  h->offset_kind = layout.offset_kind;
  h->offset_sym = layout.offset_sym;
  h->offset_left_id = layout.offset_left_id;
  h->offset_right_id = layout.offset_right_id;
  h->offset_hash32 = layout.offset_hash32;
  h->offset_next_idx = layout.offset_next_idx;
  h->offset_buckets = layout.offset_buckets;
  h->offset_term_cache = layout.offset_term_cache;

  uint32_t count = (old_top < old_cap) ? old_top : old_cap;
  atomic_store_explicit(&h->top, count, memory_order_release);

  uint8_t *base = ARENA_BASE_ADDR;

  memmove(base + h->offset_term_cache, base + old_offset_term_cache,
          TERM_CACHE_LEN * 4);

  memmove(base + h->offset_next_idx, base + old_offset_next, count * 4);
  if (new_cap > old_cap)
    memset(base + h->offset_next_idx + old_cap * 4, 0, (new_cap - old_cap) * 4);

  memmove(base + h->offset_hash32, base + old_offset_hash, count * 4);
  if (new_cap > old_cap)
    memset(base + h->offset_hash32 + old_cap * 4, 0, (new_cap - old_cap) * 4);

  memmove(base + h->offset_right_id, base + old_offset_right, count * 4);
  if (new_cap > old_cap)
    memset(base + h->offset_right_id + old_cap * 4, 0, (new_cap - old_cap) * 4);

  memmove(base + h->offset_left_id, base + old_offset_left, count * 4);
  if (new_cap > old_cap)
    memset(base + h->offset_left_id + old_cap * 4, 0, (new_cap - old_cap) * 4);

  memmove(base + h->offset_sym, base + old_offset_sym, count);
  if (new_cap > old_cap)
    memset(base + h->offset_sym + old_cap, 0, new_cap - old_cap);

  memmove(base + h->offset_kind, base + old_offset_kind, count);
  if (new_cap > old_cap)
    memset(base + h->offset_kind + old_cap, 0, new_cap - old_cap);

  atomic_uint *buckets = (atomic_uint *)(base + h->offset_buckets);
  atomic_uint *next = (atomic_uint *)(base + h->offset_next_idx);
  atomic_uchar *kind = (atomic_uchar *)(base + h->offset_kind);
  atomic_uint *hashes = (atomic_uint *)(base + h->offset_hash32);

  for (uint32_t i = 0; i < new_cap; i++)
    atomic_store_explicit(&buckets[i], EMPTY, memory_order_release);
  for (uint32_t i = 0; i < count; i++) {
    if (atomic_load_explicit(&kind[i], memory_order_acquire) !=
        ARENA_KIND_NON_TERM)
      continue;
    uint32_t hv = atomic_load_explicit(&hashes[i], memory_order_acquire);
    uint32_t b = hv & h->bucket_mask;
    while (true) {
      uint32_t head = atomic_load_explicit(&buckets[b], memory_order_acquire);
      atomic_store_explicit(&next[i], head, memory_order_relaxed);
      if (atomic_compare_exchange_weak_explicit(&buckets[b], &head, i,
                                                memory_order_release,
                                                memory_order_relaxed))
        break;
    }
  }

  atomic_fetch_add_explicit(&h->resize_seq, 1, memory_order_release);
}

static inline void update_continuation(uint32_t id, uint32_t stack,
                                       uint32_t parent, uint8_t stage) {
  while (true) {
    SabHeader *h;
    uint32_t seq = enter_stable(&h);

    atomic_uchar *sym = (atomic_uchar *)(ARENA_BASE_ADDR + h->offset_sym);
    atomic_uint *left = (atomic_uint *)(ARENA_BASE_ADDR + h->offset_left_id);
    atomic_uint *right = (atomic_uint *)(ARENA_BASE_ADDR + h->offset_right_id);

    atomic_store_explicit(&sym[id], stage, memory_order_relaxed);
    atomic_store_explicit(&left[id], stack, memory_order_relaxed);
    atomic_store_explicit(&right[id], parent, memory_order_relaxed);

    if (check_stable(seq))
      return;
  }
}

__attribute__((unused)) static uint32_t unwind_to_root(uint32_t curr,
                                                       uint32_t stack) {
  while (stack != EMPTY) {
    uint32_t recycled = stack;
    stack = leftOf(recycled);
    uint32_t parent_node = rightOf(recycled);
    uint8_t stage = (uint8_t)symOf(recycled);

    if (stage == STAGE_LEFT) {
      if (curr != leftOf(parent_node)) {
        curr = allocCons(curr, rightOf(parent_node));
      } else {
        curr = parent_node;
      }
    } else {
      if (curr != rightOf(parent_node)) {
        curr = allocCons(leftOf(parent_node), curr);
      } else {
        curr = parent_node;
      }
    }
  }
  return curr;
}

static inline StepOutcome budget_outcome(uint8_t mode, uint32_t curr,
                                         uint32_t stack,
                                         uint32_t remaining_steps) {
  StepOutcome o;
  o.type = RESULT_YIELD;
  o.val =
      alloc_generic(ARENA_KIND_SUSPENSION, mode, curr, stack, remaining_steps);
  return o;
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

static StepOutcome step_iterative(uint32_t curr, uint32_t stack, uint8_t mode,
                                  uint32_t *gas, uint32_t *remaining_steps,
                                  uint32_t free_node) {
  (void)free_node;
  while (true) {
    if (*gas == 0) {
      return budget_outcome(mode, curr, stack, *remaining_steps);
    }
    (*gas)--;

    if (mode == MODE_RETURN) {
      if (stack == EMPTY) {
        StepOutcome o;
        o.type = RESULT_DONE;
        o.val = curr;
        return o;
      }
      uint32_t recycled = stack;
      stack = leftOf(recycled);
      uint32_t parent_node = rightOf(recycled);
      uint8_t stage = (uint8_t)symOf(recycled);

      if (stage == STAGE_LEFT) {
        if (curr != leftOf(parent_node)) {
          curr = allocCons(curr, rightOf(parent_node));
          mode = MODE_RETURN;
          continue;
        }
        update_continuation(recycled, stack, parent_node, STAGE_RIGHT);
        stack = recycled;
        mode = MODE_DESCEND;
        curr = rightOf(parent_node);
        continue;
      } else {
        if (curr != rightOf(parent_node)) {
          curr = allocCons(leftOf(parent_node), curr);
        } else {
          curr = parent_node;
        }
        mode = MODE_RETURN;
        continue;
      }
    }

    if (kindOf(curr) != ARENA_KIND_NON_TERM) {
      mode = MODE_RETURN;
      continue;
    }

    uint32_t left = leftOf(curr);
    uint32_t right = rightOf(curr);

    if (kindOf(left) == ARENA_KIND_TERMINAL) {
      uint32_t sym = symOf(left);
      if (sym == ARENA_SYM_I) {
        if (*remaining_steps == 0) {
          return budget_outcome(mode, curr, stack, 0);
        }
        (*remaining_steps)--;
        curr = right;
        mode = MODE_DESCEND;
        continue;
      }
      if (sym == ARENA_SYM_READ_ONE) {
        SabHeader *h = (SabHeader *)ARENA_BASE_ADDR;
        uint8_t byte;
        if (try_dequeue((Ring *)(ARENA_BASE_ADDR + h->offset_stdin), &byte,
                        1)) {
          if (*remaining_steps == 0) {
            return budget_outcome(mode, curr, stack, 0);
          }
          (*remaining_steps)--;
          curr = allocCons(right, allocU8(byte));
          mode = MODE_DESCEND;
          continue;
        }
        /* Blocked on stdin: suspend. */
        uint32_t susp_id = alloc_generic(ARENA_KIND_SUSPENSION, MODE_IO_WAIT,
                                         curr, stack, *remaining_steps);
        enqueue_blocking((Ring *)(ARENA_BASE_ADDR + h->offset_stdin_wait),
                         &susp_id, 4);
        StepOutcome o;
        o.type = RESULT_YIELD;
        o.val = susp_id;
        return o;
      }
      if (sym == ARENA_SYM_WRITE_ONE) {
        if (kindOf(right) != ARENA_KIND_U8) {
          curr = right;
          mode = MODE_DESCEND;
          continue;
        }
        uint8_t byte = (uint8_t)symOf(right);
        SabHeader *h = (SabHeader *)ARENA_BASE_ADDR;
        if (try_enqueue((Ring *)(ARENA_BASE_ADDR + h->offset_stdout), &byte,
                        1)) {
          if (*remaining_steps == 0) {
            return budget_outcome(mode, curr, stack, 0);
          }
          (*remaining_steps)--;
          curr = right;
          mode = MODE_DESCEND;
          continue;
        }
        /* Blocked on stdout: suspend. */
        uint32_t susp_id = alloc_generic(ARENA_KIND_SUSPENSION, MODE_IO_WAIT,
                                         curr, stack, *remaining_steps);
        enqueue_blocking((Ring *)(ARENA_BASE_ADDR + h->offset_stdout_wait),
                         &susp_id, 4);
        StepOutcome o;
        o.type = RESULT_YIELD;
        o.val = susp_id;
        return o;
      }
    } else if (kindOf(left) == ARENA_KIND_NON_TERM) {
      uint32_t ll = leftOf(left);
      if (kindOf(ll) == ARENA_KIND_TERMINAL && symOf(ll) == ARENA_SYM_EQ_U8) {
        uint32_t a = rightOf(left);
        uint32_t b = right;
        if (kindOf(a) == ARENA_KIND_U8 && kindOf(b) == ARENA_KIND_U8) {
          if (*remaining_steps == 0) {
            return budget_outcome(mode, curr, stack, 0);
          }
          (*remaining_steps)--;
          uint8_t va = (uint8_t)symOf(a);
          uint8_t vb = (uint8_t)symOf(b);
          curr = (va == vb) ? arenaTrue() : arenaFalse();
          mode = MODE_DESCEND;
          continue;
        }
      }
      if (kindOf(ll) == ARENA_KIND_TERMINAL &&
          symOf(ll) == ARENA_SYM_WRITE_ONE) {
        uint32_t a = rightOf(left);
        uint32_t b = right;
        if (kindOf(a) != ARENA_KIND_U8) {
          curr = a;
          mode = MODE_DESCEND;
          continue;
        }
        uint8_t byte = (uint8_t)symOf(a);
        SabHeader *h = (SabHeader *)ARENA_BASE_ADDR;
        if (try_enqueue((Ring *)(ARENA_BASE_ADDR + h->offset_stdout), &byte,
                        1)) {
          if (*remaining_steps == 0) {
            return budget_outcome(mode, curr, stack, 0);
          }
          (*remaining_steps)--;
          curr = allocCons(b, a);
          mode = MODE_DESCEND;
          continue;
        }
        /* Blocked on stdout: suspend. */
        uint32_t susp_id = alloc_generic(ARENA_KIND_SUSPENSION, MODE_IO_WAIT,
                                         curr, stack, *remaining_steps);
        enqueue_blocking((Ring *)(ARENA_BASE_ADDR + h->offset_stdout_wait),
                         &susp_id, 4);
        StepOutcome o;
        o.type = RESULT_YIELD;
        o.val = susp_id;
        return o;
      }
      if (kindOf(ll) == ARENA_KIND_TERMINAL && symOf(ll) == ARENA_SYM_K) {
        if (*remaining_steps == 0) {
          return budget_outcome(mode, curr, stack, 0);
        }
        (*remaining_steps)--;
        curr = rightOf(left);
        mode = MODE_DESCEND;
        continue;
      }
      if (kindOf(ll) == ARENA_KIND_NON_TERM) {
        uint32_t lll = leftOf(ll);
        if (kindOf(lll) == ARENA_KIND_TERMINAL) {
          uint32_t sym = symOf(lll);
          if (sym == ARENA_SYM_S) {
            if (*remaining_steps == 0)
              return budget_outcome(mode, curr, stack, 0);
            (*remaining_steps)--;
            uint32_t x = rightOf(ll), y = rightOf(left), z = right;
            curr = allocCons(allocCons(x, z), allocCons(y, z));
            mode = MODE_DESCEND;
            continue;
          }
          if (sym == ARENA_SYM_B) {
            if (*remaining_steps == 0)
              return budget_outcome(mode, curr, stack, 0);
            (*remaining_steps)--;
            uint32_t x = rightOf(ll), y = rightOf(left), z = right;
            curr = allocCons(x, allocCons(y, z));
            mode = MODE_DESCEND;
            continue;
          }
          if (sym == ARENA_SYM_C) {
            if (*remaining_steps == 0)
              return budget_outcome(mode, curr, stack, 0);
            (*remaining_steps)--;
            uint32_t x = rightOf(ll), y = rightOf(left), z = right;
            curr = allocCons(allocCons(x, z), y);
            mode = MODE_DESCEND;
            continue;
          }
        } else if (kindOf(lll) == ARENA_KIND_NON_TERM) {
          uint32_t llll = leftOf(lll);
          if (kindOf(llll) == ARENA_KIND_TERMINAL) {
            uint32_t sym = symOf(llll);
            if (sym == ARENA_SYM_SPRIME) {
              if (*remaining_steps == 0)
                return budget_outcome(mode, curr, stack, 0);
              (*remaining_steps)--;
              uint32_t w = rightOf(lll), x = rightOf(ll), y = rightOf(left),
                       z = right;
              curr = allocCons(allocCons(w, allocCons(x, z)), allocCons(y, z));
              mode = MODE_DESCEND;
              continue;
            }
            if (sym == ARENA_SYM_BPRIME) {
              if (*remaining_steps == 0)
                return budget_outcome(mode, curr, stack, 0);
              (*remaining_steps)--;
              uint32_t w = rightOf(lll), x = rightOf(ll), y = rightOf(left),
                       z = right;
              curr = allocCons(allocCons(w, x), allocCons(y, z));
              mode = MODE_DESCEND;
              continue;
            }
            if (sym == ARENA_SYM_CPRIME) {
              if (*remaining_steps == 0)
                return budget_outcome(mode, curr, stack, 0);
              (*remaining_steps)--;
              uint32_t w = rightOf(lll), x = rightOf(ll), y = rightOf(left),
                       z = right;
              curr = allocCons(allocCons(w, allocCons(x, z)), y);
              mode = MODE_DESCEND;
              continue;
            }
          }
        }
      }
    }

    stack = alloc_generic(ARENA_KIND_CONTINUATION, STAGE_LEFT, stack, curr, 0);
    curr = left;
    mode = MODE_DESCEND;
  }
}

uint32_t arenaKernelStep(uint32_t expr) {
  ensure_arena();
  uint32_t curr = expr;
  uint32_t stack = EMPTY;
  uint8_t mode = MODE_DESCEND;

  uint32_t remaining_steps = 1;
  uint32_t free_node = EMPTY;

  if (kindOf(curr) == ARENA_KIND_SUSPENSION) {
    uint32_t susp = curr;
    curr = leftOf(susp);
    stack = rightOf(susp);
    mode = (uint8_t)symOf(susp);
    if (mode == MODE_IO_WAIT)
      mode = MODE_DESCEND;
    SabHeader *h = (SabHeader *)ARENA_BASE_ADDR;
    atomic_uint *hashes = (atomic_uint *)(ARENA_BASE_ADDR + h->offset_hash32);
    remaining_steps = atomic_load_explicit(&hashes[susp], memory_order_acquire);
    free_node = susp;
  }

  while (remaining_steps > 0) {
    uint32_t gas = ARENA_STEP_GAS;
    StepOutcome o =
        step_iterative(curr, stack, mode, &gas, &remaining_steps, free_node);

    if (o.type == RESULT_YIELD) {
      if (symOf(o.val) == MODE_IO_WAIT)
        return o.val;
      uint32_t susp = o.val;
      curr = leftOf(susp);
      stack = rightOf(susp);
      mode = (uint8_t)symOf(susp);
      SabHeader *h = (SabHeader *)ARENA_BASE_ADDR;
      atomic_uint *hashes = (atomic_uint *)(ARENA_BASE_ADDR + h->offset_hash32);
      remaining_steps =
          atomic_load_explicit(&hashes[susp], memory_order_acquire);
      free_node = susp;
      continue;
    }

    return o.val;
  }

  return unwind_to_root(curr, stack);
}

uint32_t reduce(uint32_t expr, uint32_t max) {
  ensure_arena();
  uint32_t limit = (max == 0xffffffff) ? 0xffffffff : max;
  uint32_t cur = expr;
  for (uint32_t i = 0; i < limit; i++) {
    uint32_t next = arenaKernelStep(cur);
    if (next == cur)
      break;
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
    uint32_t node = cqe.node_id & 0x3fffffff;
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

void workerLoop(void) {
  ensure_arena();
  SabHeader *h = (SabHeader *)ARENA_BASE_ADDR;
  Ring *sq = (Ring *)(ARENA_BASE_ADDR + h->offset_sq);
  Ring *cq = (Ring *)(ARENA_BASE_ADDR + h->offset_cq);
  uint32_t batch_gas = ARENA_STEP_GAS;
  while (true) {
    Sqe job;
    dequeue_blocking(sq, &job, sizeof(Sqe));
    uint32_t curr = job.node_id;
    uint32_t stack = EMPTY;
    uint8_t mode = MODE_DESCEND;
    uint32_t remaining_steps;
    uint32_t free_node = EMPTY;

    if (kindOf(curr) == ARENA_KIND_SUSPENSION) {
      uint32_t susp = curr;
      curr = leftOf(susp);
      stack = rightOf(susp);
      mode = (uint8_t)symOf(susp);
      if (mode == MODE_IO_WAIT)
        mode = MODE_DESCEND;
      atomic_uint *hashes = (atomic_uint *)(ARENA_BASE_ADDR + h->offset_hash32);
      remaining_steps =
          atomic_load_explicit(&hashes[susp], memory_order_acquire);
      free_node = susp;
    } else {
      remaining_steps =
          (job.max_steps == 0xffffffff) ? 0xffffffff : job.max_steps;
    }

    while (true) {
      if (remaining_steps == 0) {
        uint32_t susp_id =
            alloc_generic(ARENA_KIND_SUSPENSION, mode, curr, stack, 0);
        Cqe result = {susp_id, job.req_id, CQ_EVENT_YIELD};
        enqueue_blocking(cq, &result, sizeof(Cqe));
        break;
      }
      uint32_t gas = batch_gas;
      StepOutcome o =
          step_iterative(curr, stack, mode, &gas, &remaining_steps, free_node);
      if (o.type == RESULT_YIELD) {
        Cqe res = {o.val, job.req_id,
                   (symOf(o.val) == MODE_IO_WAIT) ? CQ_EVENT_IO_WAIT
                                                  : CQ_EVENT_YIELD};
        enqueue_blocking(cq, &res, sizeof(Cqe));
        break;
      } else {
        if (o.val == curr) {
          Cqe res = {curr, job.req_id, CQ_EVENT_DONE};
          enqueue_blocking(cq, &res, sizeof(Cqe));
          break;
        }
        curr = o.val;
        stack = EMPTY;
        mode = MODE_DESCEND;
        free_node = EMPTY;
      }
    }
  }
}

uint32_t debugGetArenaBaseAddr(void) {
  return (uint32_t)(uintptr_t)ARENA_BASE_ADDR;
}
uint32_t getArenaMode(void) { return ARENA_MODE; }
uint32_t debugCalculateArenaSize(uint32_t capacity) {
  return calculate_layout(capacity).total_size;
}
uint32_t debugLockState(void) {
  ensure_arena();
  SabHeader *h = (SabHeader *)ARENA_BASE_ADDR;
  return atomic_load_explicit(&h->resize_seq, memory_order_relaxed);
}
uint32_t debugGetRingEntries(void) { return RING_ENTRIES; }
