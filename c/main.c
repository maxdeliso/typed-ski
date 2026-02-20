#define _DEFAULT_SOURCE
#include "arena.h"
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>

static void *worker_thread(void *arg) {
  (void)arg;
  workerLoop();
  return NULL;
}

int main(int argc, char **argv) {
  int num_threads = 4;
  if (argc > 1)
    num_threads = atoi(argv[1]);

  printf("Initializing arena with %d threads...\n", num_threads);
  initArena(1 << 20);

  pthread_t *threads = malloc(sizeof(pthread_t) * num_threads);
  for (int i = 0; i < num_threads; i++) {
    pthread_create(&threads[i], NULL, worker_thread, NULL);
  }

  uint32_t s = allocTerminal(ARENA_SYM_S);
  uint32_t k = allocTerminal(ARENA_SYM_K);
  uint32_t i = allocTerminal(ARENA_SYM_I);
  uint32_t ki = allocCons(k, i);
  uint32_t ski = allocCons(allocCons(s, k), i);
  uint32_t expr = allocCons(ski, ki);

  printf("Submitting job (root node %u)...\n", expr);
  hostSubmit(expr, 123, 0xffffffff);

  printf("Testing binary numerals...\n");
  for (int b = 0; b < 256; b++) {
    uint32_t bin = alloc_bin_byte((uint8_t)b);
    uint8_t decoded = decode_bin_u8(bin);
    if (decoded != b) {
      printf("Binary numeral mismatch! expected=%d, got=%d\n", b, decoded);
      return 1;
    }
  }
  printf("Binary numerals test passed.\n");

  while (true) {
    int64_t res = hostPullV2();
    if (res != -1) {
      uint32_t req_id = (uint32_t)(res >> 32);
      uint32_t packed_low = (uint32_t)res;
      uint32_t event = packed_low >> 30;
      uint32_t node = packed_low & 0x3fffffff;

      printf("Received result: req_id=%u, event=%u, node=%u\n", req_id, event,
             node);
      if (event == CQ_EVENT_DONE) {
        printf("Reduction complete!\n");
        break;
      }
    }
    usleep(1000);
  }

  return 0;
}
