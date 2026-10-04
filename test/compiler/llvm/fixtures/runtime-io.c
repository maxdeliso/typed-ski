#include "trip_runtime.h"
#include <stdio.h>

int runtime_io_bulk_probe(void) {
  const trip_obj_t *list = trip_read_stdin_list_u8();
  while (trip_obj_tag(list) == 1) {
    trip_write_one((uint8_t)trip_obj_field(list, 0));
    list = (const trip_obj_t *)trip_obj_field(list, 1);
  }
  return trip_obj_tag(list) == 0 ? 0 : 1;
}

/* Each prompt has no newline. The parent sends its response only after seeing
 * the prompt, proving flushing rather than merely checking output at exit. */
int runtime_io_prompt_probe(void) {
  trip_write_one('P');
  uint8_t answer = trip_read_one();
  trip_write_one(answer);
  return answer == 'Q' ? 0 : 1;
}

int runtime_io_bulk_prompt_probe(void) {
  trip_write_one('P');
  const trip_obj_t *list = trip_read_stdin_list_u8();
  if (trip_obj_tag(list) != 1 || trip_obj_field(list, 0) != 'Q') {
    return 1;
  }
  trip_write_one((uint8_t)trip_obj_field(list, 0));
  return trip_obj_tag((const trip_obj_t *)trip_obj_field(list, 1)) == 0 ? 0 : 1;
}

int runtime_io_explicit_flush_probe(void) {
  trip_write_one('P');
  trip_flush_stdout();
  int answer = fgetc(stdin);
  trip_write_one((uint8_t)answer);
  return answer == 'Q' ? 0 : 1;
}

/* An external read does not invoke the runtime's automatic flush. In default
 * mode the prior write must already be visible to the parent. */
int runtime_io_default_visibility_probe(void) {
  trip_write_one('P');
  int answer = fgetc(stdin);
  trip_write_one((uint8_t)answer);
  return answer == 'Q' ? 0 : 1;
}
