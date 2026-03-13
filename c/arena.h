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
  ARENA_SYM_EQ_U8 = 13,
  ARENA_SYM_LT_U8 = 14,
  ARENA_SYM_DIV_U8 = 15,
  ARENA_SYM_MOD_U8 = 16,
  ARENA_SYM_ADD_U8 = 17,
  ARENA_SYM_SUB_U8 = 18
} ArenaSym;

#define EMPTY 0xffffffff
#define TERM_CACHE_LEN (ARENA_SYM_SUB_U8 + 1)

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
  uint32_t offset_term_cache;
  uint64_t offset_cont_segments;
  uint64_t offset_nodes;
  uint64_t offset_buckets;
  uint32_t cont_segments;
  atomic_uint cont_free_head;
  atomic_uint cont_top;
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
#define RESULT_BUDGET 1
#define RESULT_IO_WAIT 2

typedef struct {
  uint8_t type;
  uint32_t val;
} StepOutcome;

uint32_t initArena(uint32_t initial_capacity);
uint32_t connectArena(uint32_t ptr_addr);
void reset(void);
/** Current allocation top (next node index) and capacity; for diagnostics. */
uint32_t arena_top(void);
uint32_t arena_capacity(void);
uint32_t kindOf(uint32_t n);
uint32_t symOf(uint32_t n);
uint32_t hashOf(uint32_t n);
uint32_t leftOf(uint32_t n);
uint32_t rightOf(uint32_t n);
uint32_t allocTerminal(uint32_t sym);
uint32_t allocCons(uint32_t l, uint32_t r);
uint32_t allocU8(uint8_t value);
uint32_t alloc_generic(uint8_t kind_val, uint8_t sym_val, uint32_t left_val,
                       uint32_t right_val, uint32_t hash_val);
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

/** Try to dequeue one suspension id from stdin_wait or stdout_wait (slot_size
 * 4). Used by native runtime to wake IO waiters. */
bool arena_stdin_wait_try_dequeue(uint32_t *node_id_out);
bool arena_stdout_wait_try_dequeue(uint32_t *node_id_out);

#endif
