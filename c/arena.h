#ifndef ARENA_H
#define ARENA_H

#ifdef __wasm__

typedef unsigned char uint8_t;
typedef unsigned int uint32_t;
typedef int int32_t;
typedef long long int64_t;
typedef _Bool bool;
#define true 1
#define false 0
#else
#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>
#endif
#include <stdatomic.h>

typedef enum {
  ARENA_KIND_TERMINAL = 1,
  ARENA_KIND_NON_TERM = 2,
  ARENA_KIND_CONTINUATION = 3,
  ARENA_KIND_SUSPENSION = 4,
  ARENA_KIND_U8 = 5
} ArenaKind;

typedef enum {
  ARENA_SYM_S = 1,
  ARENA_SYM_K = 2,
  ARENA_SYM_I = 3,
  ARENA_SYM_READ_ONE = 4,
  ARENA_SYM_WRITE_ONE = 5,
  ARENA_SYM_B = 8,
  ARENA_SYM_C = 9,
  ARENA_SYM_SPRIME = 10,
  ARENA_SYM_BPRIME = 11,
  ARENA_SYM_CPRIME = 12,
  ARENA_SYM_EQ_U8 = 13
} ArenaSym;

#define EMPTY 0xffffffff
#define TERM_CACHE_LEN (ARENA_SYM_EQ_U8 + 1)

typedef struct {
  atomic_uint head;
  atomic_uint not_full;
  uint8_t _pad1[56];
  atomic_uint tail;
  atomic_uint not_empty;
  uint8_t _pad2[56];
  uint32_t mask;
  uint32_t entries;
  uint8_t _pad3[56];
} Ring;

typedef struct {
  uint32_t node_id;
  uint32_t req_id;
  uint32_t max_steps;
} Sqe;

typedef struct {
  uint32_t node_id;
  uint32_t req_id;
  uint32_t event_kind;
} Cqe;

#define CQ_EVENT_DONE 0
#define CQ_EVENT_YIELD 1
#define CQ_EVENT_IO_WAIT 2
#define CQ_EVENT_ERROR 3

#define STAGE_LEFT 0
#define STAGE_RIGHT 1

#define MODE_DESCEND 0
#define MODE_RETURN 1
#define MODE_IO_WAIT 2

typedef struct {
  uint32_t magic;
  uint32_t ring_entries;
  uint32_t ring_mask;
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
  uint32_t capacity;
  uint32_t bucket_mask;
  atomic_uint resize_seq;
  atomic_uint top;
} SabHeader;

#define RESULT_DONE 0
#define RESULT_YIELD 1

typedef struct {
  uint8_t type;
  uint32_t val;
} StepOutcome;

extern uint8_t *ARENA_BASE_ADDR;
static const uint32_t ARENA_MAGIC = 0x534B4941;
static const uint32_t ARENA_STEP_GAS = 20000;
static const uint32_t INITIAL_CAP = 1 << 24;
static const uint32_t MAX_CAP = 1 << 27;
static const uint32_t RING_ENTRIES = 1 << 16;
static const uint32_t POISON_SEQ = 0xffffffff;

uint32_t initArena(uint32_t initial_capacity);
uint32_t connectArena(uint32_t ptr_addr);
void reset(void);
void ensure_arena(void);

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
      continue;
    }
    return seq;
  }
}

static inline void wait_resize_stable(void) {
  SabHeader *h = (SabHeader *)ARENA_BASE_ADDR;
  while (true) {
    uint32_t seq = atomic_load_explicit(&h->resize_seq, memory_order_acquire);
    if (seq == POISON_SEQ) {
#ifdef __wasm__
      __builtin_trap();
#else
      abort();
#endif
    }
    if (!(seq & 1))
      return;
  }
}

static inline bool check_stable(uint32_t seq) {
  SabHeader *h = (SabHeader *)ARENA_BASE_ADDR;
  return atomic_load_explicit(&h->resize_seq, memory_order_acquire) == seq;
}

static inline uint32_t kindOf_inline(uint32_t n) {
  ensure_arena();
  while (true) {
    wait_resize_stable();
    SabHeader *h;
    uint32_t seq = enter_stable(&h);
    if (n >= h->capacity)
      return 0;
    atomic_uchar *kind = (atomic_uchar *)(ARENA_BASE_ADDR + h->offset_kind);
    uint32_t val = atomic_load_explicit(&kind[n], memory_order_acquire);
    atomic_thread_fence(memory_order_acquire);
    if (check_stable(seq))
      return val;
  }
}

static inline uint32_t symOf_inline(uint32_t n) {
  ensure_arena();
  while (true) {
    wait_resize_stable();
    SabHeader *h;
    uint32_t seq = enter_stable(&h);
    if (n >= h->capacity)
      return 0;
    atomic_uchar *sym = (atomic_uchar *)(ARENA_BASE_ADDR + h->offset_sym);
    uint32_t val = atomic_load_explicit(&sym[n], memory_order_acquire);
    atomic_thread_fence(memory_order_acquire);
    if (check_stable(seq))
      return val;
  }
}

static inline uint32_t hashOf_inline(uint32_t n) {
  ensure_arena();
  while (true) {
    wait_resize_stable();
    SabHeader *h;
    uint32_t seq = enter_stable(&h);
    if (n >= h->capacity)
      return 0;
    atomic_uint *hash = (atomic_uint *)(ARENA_BASE_ADDR + h->offset_hash32);
    uint32_t val = atomic_load_explicit(&hash[n], memory_order_acquire);
    atomic_thread_fence(memory_order_acquire);
    if (check_stable(seq))
      return val;
  }
}

static inline uint32_t leftOf_inline(uint32_t n) {
  ensure_arena();
  while (true) {
    wait_resize_stable();
    SabHeader *h;
    uint32_t seq = enter_stable(&h);
    if (n >= h->capacity)
      return 0;
    atomic_uint *left = (atomic_uint *)(ARENA_BASE_ADDR + h->offset_left_id);
    uint32_t val = atomic_load_explicit(&left[n], memory_order_acquire);
    atomic_thread_fence(memory_order_acquire);
    if (check_stable(seq))
      return val;
  }
}

static inline uint32_t rightOf_inline(uint32_t n) {
  ensure_arena();
  while (true) {
    wait_resize_stable();
    SabHeader *h;
    uint32_t seq = enter_stable(&h);
    if (n >= h->capacity)
      return 0;
    atomic_uint *right = (atomic_uint *)(ARENA_BASE_ADDR + h->offset_right_id);
    uint32_t val = atomic_load_explicit(&right[n], memory_order_acquire);
    atomic_thread_fence(memory_order_acquire);
    if (check_stable(seq))
      return val;
  }
}

#define kindOf kindOf_inline
#define symOf symOf_inline
#define hashOf hashOf_inline
#define leftOf leftOf_inline
#define rightOf rightOf_inline

uint32_t allocTerminal(uint32_t sym);
uint32_t allocCons(uint32_t l, uint32_t r);
uint32_t allocU8(uint8_t value);
uint32_t arenaKernelStep(uint32_t expr);
int64_t hostPullV2(void);
/** Block until a completion is available; write it to *cqe. */
void hostCqDequeueBlocking(Cqe *cqe);
/** Enqueue a sentinel CQE (req_id=0) to wake the dispatcher (e.g. for
 * shutdown). */
void arena_cq_enqueue_shutdown_sentinel(void);
uint32_t hostSubmit(uint32_t node_id, uint32_t req_id, uint32_t max_steps);
void workerLoop(void);

/* Host I/O: push byte to arena stdin (for ',' combinator), try pop from stdout
 * (for '.'). */
void arena_stdin_push(uint8_t byte);
bool arena_stdout_try_pop(uint8_t *byte_out);

#endif
