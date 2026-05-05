#include "trip_runtime.h"

#include <stdio.h>

#ifdef _WIN32
#include <fcntl.h>
#include <io.h>
#endif

static void configure_binary_stdio(void) {
#ifdef _WIN32
  static int configured = 0;
  if (!configured) {
    (void)_setmode(_fileno(stdin), _O_BINARY);
    (void)_setmode(_fileno(stdout), _O_BINARY);
    configured = 1;
  }
#endif
}

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
