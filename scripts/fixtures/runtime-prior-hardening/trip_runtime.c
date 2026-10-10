#include "trip_runtime.h"

#include <stdio.h>
#include <stdlib.h>
#include <stddef.h>

#ifdef _WIN32
#include <fcntl.h>
#include <io.h>
#include <windows.h>

static void configure_binary_stdio(void) {
  static int configured;
  if (!configured) {
    _setmode(_fileno(stdin), _O_BINARY);
    _setmode(_fileno(stdout), _O_BINARY);
    configured = 1;
  }
}
#else
static void configure_binary_stdio(void) {}
#endif

uint8_t trip_read_one(void) {
  configure_binary_stdio();
  int byte = fgetc(stdin);
  if (byte == EOF) {
    return 0;
  }
  return (uint8_t)byte;
}

void trip_write_one(uint8_t byte) {
  configure_binary_stdio();
  (void)fputc((int)byte, stdout);
  (void)fflush(stdout);
}

/* A single-threaded, process-lifetime arena. Never move objects: generated code
 * keeps both pointers and pointer-sized integer references to them. Bulk cleanup
 * at exit bounds allocator overhead without pretending to be a garbage collector. */
typedef struct trip_arena_chunk {
  struct trip_arena_chunk *next;
  size_t used;
  size_t capacity;
  max_align_t data[];
} trip_arena_chunk_t;

static trip_arena_chunk_t *arena_chunks;
static trip_allocation_stats_t allocation_stats;

static void release_arena(void) {
#ifdef _WIN32
  char report[2];
  int report_stats = GetEnvironmentVariableA("TRIP_RUNTIME_STATS", report, sizeof(report)) == 1 && report[0] == '1';
#else
  const char *report = getenv("TRIP_RUNTIME_STATS");
  int report_stats = report != NULL && report[0] == '1' && report[1] == '\0';
#endif
  if (report_stats) {
    fprintf(stderr,
            "trip arena: objects=%llu object_bytes=%llu reserved_bytes=%llu chunks=%llu\n",
            (unsigned long long)allocation_stats.objects,
            (unsigned long long)allocation_stats.object_bytes,
            (unsigned long long)allocation_stats.reserved_bytes,
            (unsigned long long)allocation_stats.chunks);
  }
  while (arena_chunks != NULL) {
    trip_arena_chunk_t *next = arena_chunks->next;
    free(arena_chunks);
    arena_chunks = next;
  }
}

trip_allocation_stats_t trip_allocation_stats(void) {
  return allocation_stats;
}

trip_obj_t *trip_alloc_obj(uint64_t tag, uint64_t arity) {
  if (arity > (SIZE_MAX - sizeof(trip_obj_t)) / sizeof(trip_word_t)) {
    abort();
  }
  size_t bytes = sizeof(trip_obj_t) + (size_t)arity * sizeof(trip_word_t);
  const size_t alignment = _Alignof(max_align_t);
  if (bytes > SIZE_MAX - (alignment - 1)) {
    abort();
  }
  size_t aligned_bytes = (bytes + alignment - 1) / alignment * alignment;
  if (arena_chunks == NULL ||
      aligned_bytes > arena_chunks->capacity - arena_chunks->used) {
    size_t capacity = aligned_bytes > 1024 * 1024 ? aligned_bytes : 1024 * 1024;
    if (capacity > SIZE_MAX - offsetof(trip_arena_chunk_t, data)) {
      abort();
    }
    if (arena_chunks == NULL && atexit(release_arena) != 0) {
      abort();
    }
    size_t reserved = offsetof(trip_arena_chunk_t, data) + capacity;
    trip_arena_chunk_t *chunk = (trip_arena_chunk_t *)calloc(1, reserved);
    if (chunk == NULL) {
      abort();
    }
    chunk->next = arena_chunks;
    chunk->capacity = capacity;
    arena_chunks = chunk;
    allocation_stats.chunks++;
    allocation_stats.reserved_bytes += reserved;
  }
  trip_obj_t *obj = (trip_obj_t *)((unsigned char *)arena_chunks->data + arena_chunks->used);
  arena_chunks->used += aligned_bytes;
  obj->tag = tag;
  obj->arity = arity;
  allocation_stats.objects++;
  allocation_stats.object_bytes += bytes;
  return obj;
}

void trip_obj_set_field(trip_obj_t *obj, uint64_t index, trip_word_t value) {
  if (obj == NULL || index >= obj->arity) {
    fprintf(stderr, "CRITICAL: trip_obj_set_field with obj=%p index=%llu arity=%llu\n", (void*)obj, (unsigned long long)index, obj ? (unsigned long long)obj->arity : 0);
    abort();
  }
  obj->fields[index] = value;
}

uint64_t trip_obj_tag(const trip_obj_t *obj) {
  if (obj == NULL) {
    fprintf(stderr, "CRITICAL: obj is NULL in trip_obj_tag\n");
    abort();
  }
  if ((uintptr_t)obj == 1) {
    return 0;
  }
  if ((uintptr_t)obj == 2) {
    return 1;
  }
  if ((uintptr_t)obj < 256) {
    fprintf(stderr, "CRITICAL: Unexpected small pointer (%p) in trip_obj_tag\n", (void*)obj);
    abort();
  }
#ifdef _WIN32
  if (IsBadReadPtr(obj, sizeof(trip_obj_t))) {
    fprintf(stderr, "CRITICAL: IsBadReadPtr(%p) in trip_obj_tag\n", (void*)obj);
    abort();
  }
#endif
  return obj->tag;
}

trip_word_t trip_obj_field(const trip_obj_t *obj, uint64_t index) {
  if (obj == NULL) {
    fprintf(stderr, "CRITICAL: obj is NULL in trip_obj_field\n");
    abort();
  }
  if ((uintptr_t)obj < 256) {
    fprintf(stderr, "CRITICAL: obj < 256 (%p) in trip_obj_field (index=%llu)\n", (void*)obj, (unsigned long long)index);
    abort();
  }
#ifdef _WIN32
  if (IsBadReadPtr(obj, sizeof(trip_obj_t))) {
    fprintf(stderr, "CRITICAL: IsBadReadPtr(%p) in trip_obj_field (index=%llu)\n", (void*)obj, (unsigned long long)index);
    abort();
  }
#endif
  if (index >= obj->arity) {
    fprintf(stderr, "CRITICAL: Index %llu >= arity %llu in trip_obj_field (obj=%p, tag=%llu)\n", (unsigned long long)index, (unsigned long long)obj->arity, (void*)obj, (unsigned long long)obj->tag);
    abort();
  }
  return obj->fields[index];
}

trip_obj_t *trip_read_stdin_list_u8(void) {
  configure_binary_stdio();

  size_t capacity = 256;
  size_t length = 0;
  uint8_t *bytes = (uint8_t *)malloc(capacity);
  if (bytes == NULL) {
    abort();
  }

  for (;;) {
    int byte = fgetc(stdin);
    if (byte == EOF) {
      break;
    }
    if (length == capacity) {
      size_t next_capacity = capacity * 2;
      if (next_capacity < capacity) {
        free(bytes);
        abort();
      }
      uint8_t *next = (uint8_t *)realloc(bytes, next_capacity);
      if (next == NULL) {
        free(bytes);
        abort();
      }
      bytes = next;
      capacity = next_capacity;
    }
    bytes[length++] = (uint8_t)byte;
  }

  trip_obj_t *list = trip_alloc_obj(0, 0);
  while (length > 0) {
    trip_obj_t *cons = trip_alloc_obj(1, 2);
    length--;
    trip_obj_set_field(cons, 0, (trip_word_t)bytes[length]);
    trip_obj_set_field(cons, 1, (trip_word_t)list);
    list = cons;
  }

  free(bytes);
  return list;
}
