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
#endif
#include <stdatomic.h>
#include <stddef.h>

typedef enum {
  ARENA_KIND_TERMINAL = 1,
  ARENA_KIND_NON_TERM = 2,
  ARENA_KIND_U8 = 3
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
  ARENA_SYM_EQ_U8 = 13,
  ARENA_SYM_LT_U8 = 14,
  ARENA_SYM_DIV_U8 = 15,
  ARENA_SYM_MOD_U8 = 16,
  ARENA_SYM_ADD_U8 = 17,
  ARENA_SYM_SUB_U8 = 18
} ArenaSym;

#define EMPTY 0xffffffff
#define TERM_CACHE_LEN (ARENA_SYM_SUB_U8 + 1)
#define CONTROL_PTR_BIT 0x80000000u

static inline bool is_control_ptr(uint32_t ptr) {
  return (ptr & CONTROL_PTR_BIT) != 0;
}
static inline bool is_value_ptr(uint32_t ptr) {
  return (ptr & CONTROL_PTR_BIT) == 0;
}
static inline uint32_t control_index(uint32_t ptr) {
  return ptr & ~CONTROL_PTR_BIT;
}
static inline uint32_t make_control_ptr(uint32_t idx) {
  return idx | CONTROL_PTR_BIT;
}

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

typedef enum {
  FRAME_UPDATE = 1,
} FrameKind;

typedef enum {
  SUSP_WAIT_IO_STDIN = 1,
  SUSP_WAIT_IO_STDOUT = 2,
  SUSP_GAS_EXHAUSTED = 3,
  SUSP_STEP_LIMIT = 4,
  SUSP_IO_EOF = 5,
  SUSP_IO_ERROR = 6,
} SuspensionReason;

typedef enum {
  SUSP_STATUS_FREE = 0,
  SUSP_STATUS_PARKED = 1,
  SUSP_STATUS_READY = 2,
  SUSP_STATUS_CLAIMED = 3,
} SuspensionStatus;

typedef enum {
  WORKER_RUNNING = 1,
  WORKER_YIELD_RETRY = 2,
  WORKER_IDLE = 3,
} WorkerStatus;

typedef struct {
  uint8_t kind;
  uint8_t submode;
  uint16_t flags;
  uint32_t a;
  uint32_t b;
} Frame;

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
  uint32_t max_capacity;
  atomic_uint capacity;
  uint32_t bucket_mask;
  atomic_uint resize_seq;
  atomic_uint top;
  _Atomic uint64_t total_nodes;
  _Atomic uint64_t total_steps;
  _Atomic uint64_t total_cons_allocs;
  _Atomic uint64_t total_cont_allocs;
  _Atomic uint64_t total_susp_allocs;
  _Atomic uint64_t duplicate_lost_allocs;
  _Atomic uint64_t hashcons_hits;
  _Atomic uint64_t hashcons_misses;
} SabHeader;

#define RESULT_DONE 0
#define RESULT_YIELD 1

typedef struct {
  uint8_t type;
  uint32_t val;
} StepOutcome;

uint32_t initArena(uint32_t initial_capacity);
uint32_t connectArena(uint32_t ptr_addr);
uint32_t arena_max_capacity(void);
void reset(void);
/** Current allocation top (next node index) and capacity; for diagnostics. */
uint32_t arena_top(void);
uint32_t arena_capacity(void);
unsigned long long arena_total_nodes(void);
unsigned long long arena_total_steps(void);
unsigned long long arena_total_cons_allocs(void);
unsigned long long arena_total_cont_allocs(void);
unsigned long long arena_total_susp_allocs(void);
unsigned long long arena_duplicate_lost_allocs(void);
unsigned long long arena_hashcons_hits(void);
unsigned long long arena_hashcons_misses(void);
uint32_t kindOf(uint32_t n);
uint32_t symOf(uint32_t n);
uint32_t hashOf(uint32_t n);
uint32_t leftOf(uint32_t n);
uint32_t rightOf(uint32_t n);
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
void workerLoop(uint32_t worker_id);

/* Host I/O: push byte to arena stdin (for ',' combinator), try pop from stdout
 * (for '.'). */
void arena_stdin_push(uint8_t byte);
bool arena_stdout_try_pop(uint8_t *byte_out);

/* Zero-copy file mapping interface */
void arena_set_io_mmap(uint8_t *in_map, size_t in_size, uint8_t *out_map,
                       size_t out_size);
size_t arena_get_mmap_out_cursor(void);

/* Hash mixer selected at compile time for allocCons(). */
const char *arena_hash_mix_name(void);

/* Bucket extractor selected at compile time for hashcons buckets. */
const char *arena_hash_bucket_name(void);

/* Snapshot hash bucket occupancy: items = sum(chain_len), used_buckets =
 * count(chain_len > 0), chain_sq_sum = sum(chain_len^2). */
void arena_hash_table_stats(unsigned long long *out_items,
                            unsigned long long *out_used_buckets,
                            unsigned long long *out_chain_sq_sum,
                            uint32_t *out_max_chain);

/** Try to dequeue one suspension id from stdin_wait or stdout_wait (slot_size
 * 4). Used by native runtime to wake IO waiters. */
bool arena_stdin_wait_try_dequeue(uint32_t *node_id_out);
bool arena_stdout_wait_try_dequeue(uint32_t *node_id_out);

/* Control-pointer introspection for native scheduler/runtime integration. */
uint32_t controlSuspensionReason(uint32_t ptr);
uint32_t controlSuspensionCurrentValue(uint32_t ptr);
uint32_t controlSuspensionRemainingSteps(uint32_t ptr);
void arena_debug_ring_occupancy(uint32_t *out_sq_count, uint32_t *out_cq_count);

/* Cooperative native trace dump support (no-op unless thanatos enables it). */
void arena_trace_init(uint32_t worker_count);
void arena_trace_request_epoch(uint32_t epoch);
void arena_trace_capture_idle_workers(uint32_t epoch, uint32_t worker_count);
bool arena_trace_wait_for_epoch(uint32_t epoch, uint32_t worker_count,
                                uint32_t timeout_ms);
bool arena_trace_write_dump_json(const char *path, uint32_t epoch,
                                 uint32_t worker_count, bool timed_out);

uint32_t debugGetArenaBaseAddr(void);
uint32_t getArenaMode(void);
uint32_t debugCalculateArenaSize(uint32_t capacity);
uint32_t debugLockState(void);
uint32_t debugGetRingEntries(void);

#endif
