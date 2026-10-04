#include "trip_runtime.h"
#include <assert.h>
#include <stddef.h>

int runtime_arena_probe(void) {
  trip_obj_t *root = trip_alloc_obj(41, 2);
  assert(trip_allocation_stats().reserved_bytes < 128 * 1024);
  trip_obj_set_field(root, 0, 73);
  trip_obj_set_field(root, 1, (trip_word_t)root);
  trip_obj_t *odd = trip_alloc_obj(42, 1);
  trip_obj_t *after_odd = trip_alloc_obj(43, 1);
  const size_t odd_bytes = sizeof(trip_obj_t) + sizeof(trip_word_t);
  const size_t alignment = _Alignof(trip_obj_t);
  assert((uintptr_t)after_odd - (uintptr_t)odd ==
         (odd_bytes + alignment - 1) / alignment * alignment);
  for (size_t i = 0; i < 100000; ++i) {
    trip_obj_t *obj = trip_alloc_obj(i, 3);
    assert((uintptr_t)obj % _Alignof(trip_obj_t) == 0);
    assert(trip_obj_tag(obj) == i);
    assert(trip_obj_field(obj, 0) == 0);
    assert(trip_obj_field(obj, 1) == 0);
    assert(trip_obj_field(obj, 2) == 0);
    trip_obj_set_field(obj, 2, (trip_word_t)root);
  }
  /* Larger than a normal chunk, followed by another ordinary allocation. */
  const uint64_t large_arity = 131073;
  const uint64_t chunks_before_large = trip_allocation_stats().chunks;
  trip_obj_t *large = trip_alloc_obj(99, large_arity);
  assert(trip_obj_field(large, large_arity - 1) == 0);
  trip_obj_set_field(large, large_arity - 1, 255);
  trip_obj_t *last = trip_alloc_obj(7, 0);
  assert(trip_allocation_stats().chunks == chunks_before_large + 1);
  assert(last != root && last != large);
  assert(trip_obj_tag(root) == 41);
  assert(trip_obj_field(root, 0) == 73);
  assert(trip_obj_field(root, 1) == (trip_word_t)root);
  assert(trip_obj_field(large, large_arity - 1) == 255);
  trip_allocation_stats_t stats = trip_allocation_stats();
  assert(stats.objects == 100005);
  assert(stats.object_bytes ==
         100005 * sizeof(trip_obj_t) +
         (4 + 100000 * 3 + large_arity) * sizeof(trip_word_t));
  assert(stats.reserved_bytes >= stats.object_bytes);
  assert(stats.chunks > 1 && stats.chunks < 20);
  return 0;
}
