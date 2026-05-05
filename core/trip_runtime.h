#ifndef TRIP_RUNTIME_H
#define TRIP_RUNTIME_H

#include <stdint.h>

uint8_t trip_read_one(void);
void trip_write_one(uint8_t byte);

#endif
