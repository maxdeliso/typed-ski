#include "trip_runtime.h"

#include <stdio.h>
#include <stdlib.h>
#include <stddef.h>

#ifdef _WIN32
#include <fcntl.h>
#include <io.h>
#include <windows.h>
#endif

static int environment_flag(const char *name) {
#ifdef _WIN32
  char value[2];
  return GetEnvironmentVariableA(name, value, sizeof(value)) == 1 &&
         value[0] == '1';
#else
  const char *value = getenv(name);
  return value != NULL && value[0] == '1' && value[1] == '\0';
#endif
}

static int buffered_output;
static uint8_t output_buffer[64 * 1024];
static size_t output_length;

static void configure_stdio(void) {
  static int configured;
  if (configured) {
    return;
  }
#ifdef _WIN32
  _setmode(_fileno(stdin), _O_BINARY);
  _setmode(_fileno(stdout), _O_BINARY);
#endif
  buffered_output = environment_flag("TRIP_RUNTIME_BUFFER_OUTPUT");
  configured = 1;
  if (buffered_output && atexit(trip_flush_stdout) != 0) {
    buffered_output = 0;
  }
}

void trip_flush_stdout(void) {
  configure_stdio();
  if (output_length > 0) {
    (void)fwrite(output_buffer, 1, output_length, stdout);
    output_length = 0;
  }
  (void)fflush(stdout);
}

uint8_t trip_read_one(void) {
  configure_stdio();
  /* A prompt must be visible before waiting for input, including on a pipe. */
  if (output_length > 0) {
    trip_flush_stdout();
  }
  int byte = fgetc(stdin);
  if (byte == EOF) {
    return 0;
  }
  return (uint8_t)byte;
}

void trip_write_one(uint8_t byte) {
  configure_stdio();
  if (buffered_output) {
    output_buffer[output_length++] = byte;
    if (output_length == sizeof(output_buffer)) {
      trip_flush_stdout();
    }
  } else {
    (void)fputc((int)byte, stdout);
    (void)fflush(stdout);
  }
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
static trip_arena_chunk_t *arena_current;
static size_t arena_next_capacity = 64 * 1024;
static trip_allocation_stats_t allocation_stats;

enum { TRIP_ARENA_MAX_CHUNK = 1024 * 1024 };

static void release_arena(void) {
  if (environment_flag("TRIP_RUNTIME_STATS")) {
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

static trip_arena_chunk_t *new_arena_chunk(size_t capacity) {
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
  return chunk;
}

trip_obj_t *trip_alloc_obj(uint64_t tag, uint64_t arity) {
  if (arity > (SIZE_MAX - sizeof(trip_obj_t)) / sizeof(trip_word_t)) {
    abort();
  }
  size_t bytes = sizeof(trip_obj_t) + (size_t)arity * sizeof(trip_word_t);
  /* Only the object's alignment is required: max_align_t pads common odd-arity
   * objects by another word on 64-bit hosts. The chunk base stays max-aligned. */
  const size_t alignment = _Alignof(trip_obj_t);
  if (bytes > SIZE_MAX - (alignment - 1)) {
    abort();
  }
  size_t aligned_bytes = (bytes + alignment - 1) / alignment * alignment;
  trip_arena_chunk_t *chunk;
  if (aligned_bytes > TRIP_ARENA_MAX_CHUNK) {
    /* A one-off oversized object must not discard the ordinary chunk's tail. */
    chunk = new_arena_chunk(aligned_bytes);
  } else {
    if (arena_current == NULL ||
        aligned_bytes > arena_current->capacity - arena_current->used) {
      size_t capacity = aligned_bytes > arena_next_capacity ? aligned_bytes :
                                                             arena_next_capacity;
      arena_current = new_arena_chunk(capacity);
      arena_next_capacity = capacity > TRIP_ARENA_MAX_CHUNK / 2 ?
                            TRIP_ARENA_MAX_CHUNK : capacity * 2;
    }
    chunk = arena_current;
  }
  trip_obj_t *obj = (trip_obj_t *)((unsigned char *)chunk->data + chunk->used);
  chunk->used += aligned_bytes;
  obj->tag = tag;
  obj->arity = arity;
  allocation_stats.objects++;
  allocation_stats.object_bytes += bytes;
  return obj;
}

void trip_obj_set_field(trip_obj_t *obj, uint64_t index, trip_word_t value) {
  if ((uintptr_t)obj < 256) {
    fprintf(stderr, "CRITICAL: Invalid pointer (%p) in trip_obj_set_field\n",
            (void*)obj);
    abort();
  }
  if (index >= obj->arity) {
    fprintf(stderr,
            "CRITICAL: trip_obj_set_field with obj=%p index=%llu arity=%llu\n",
            (void*)obj, (unsigned long long)index, (unsigned long long)obj->arity);
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
#if defined(_WIN32) && defined(TRIP_RUNTIME_VALIDATE_POINTERS)
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
#if defined(_WIN32) && defined(TRIP_RUNTIME_VALIDATE_POINTERS)
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
  configure_stdio();
  if (output_length > 0) {
    trip_flush_stdout();
  }

  size_t capacity = 8192;
  size_t length = 0;
  uint8_t *bytes = (uint8_t *)malloc(capacity);
  if (bytes == NULL) {
    abort();
  }

  for (;;) {
    if (length == capacity) {
      if (capacity > SIZE_MAX / 2) {
        free(bytes);
        abort();
      }
      size_t next_capacity = capacity * 2;
      uint8_t *next = (uint8_t *)realloc(bytes, next_capacity);
      if (next == NULL) {
        free(bytes);
        abort();
      }
      bytes = next;
      capacity = next_capacity;
    }
    size_t count = fread(bytes + length, 1, capacity - length, stdin);
    length += count;
    if (count == 0) {
      break;
    }
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
