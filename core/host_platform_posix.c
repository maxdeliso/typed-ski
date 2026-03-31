#ifndef _WIN32

#include "host_platform.h"

#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#if defined(__linux__)
#include <linux/futex.h>
#endif
#include <sched.h>
#include <signal.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <time.h>
#include <unistd.h>

static int runtime_stdin_fd = -1;

void host_mutex_init(HostMutex *mutex) { pthread_mutex_init(mutex, NULL); }

void host_mutex_destroy(HostMutex *mutex) { pthread_mutex_destroy(mutex); }

void host_mutex_lock(HostMutex *mutex) { pthread_mutex_lock(mutex); }

void host_mutex_unlock(HostMutex *mutex) { pthread_mutex_unlock(mutex); }

void host_cond_init(HostCond *cond) { pthread_cond_init(cond, NULL); }

void host_cond_destroy(HostCond *cond) { pthread_cond_destroy(cond); }

void host_cond_signal(HostCond *cond) { pthread_cond_signal(cond); }

void host_cond_wait(HostCond *cond, HostMutex *mutex) {
  pthread_cond_wait(cond, mutex);
}

void host_event_init(HostEvent *event) {
  pthread_mutex_init(&event->mutex, NULL);
  pthread_cond_init(&event->cond, NULL);
  event->signaled = false;
}

void host_event_destroy(HostEvent *event) {
  pthread_mutex_destroy(&event->mutex);
  pthread_cond_destroy(&event->cond);
}

void host_event_notify(HostEvent *event) {
  pthread_mutex_lock(&event->mutex);
  event->signaled = true;
  pthread_cond_signal(&event->cond);
  pthread_mutex_unlock(&event->mutex);
}

bool host_event_wait(HostEvent *event, uint32_t timeout_ms) {
  bool signaled = false;
  pthread_mutex_lock(&event->mutex);
  if (!event->signaled) {
    if (timeout_ms == 0) {
      pthread_cond_wait(&event->cond, &event->mutex);
    } else {
      struct timespec ts;
      clock_gettime(CLOCK_REALTIME, &ts);
      ts.tv_sec += timeout_ms / 1000u;
      ts.tv_nsec += (long)(timeout_ms % 1000u) * 1000000L;
      if (ts.tv_nsec >= 1000000000L) {
        ts.tv_sec += 1;
        ts.tv_nsec -= 1000000000L;
      }
      (void)pthread_cond_timedwait(&event->cond, &event->mutex, &ts);
    }
  }
  signaled = event->signaled;
  event->signaled = false;
  pthread_mutex_unlock(&event->mutex);
  return signaled;
}

int host_thread_create(HostThread *thread, HostThreadFn fn, void *arg) {
  return pthread_create(thread, NULL, fn, arg);
}

void host_thread_join(HostThread thread) { pthread_join(thread, NULL); }

void *host_reserve_memory(size_t bytes) {
  void *ptr =
      mmap(NULL, bytes, PROT_NONE, MAP_ANONYMOUS | MAP_PRIVATE, -1, 0);
  return ptr == MAP_FAILED ? NULL : ptr;
}

bool host_commit_memory_range(void *base, size_t offset, size_t bytes) {
  static size_t page_size = 0;
  if (page_size == 0) {
    long value = sysconf(_SC_PAGESIZE);
    page_size = (value > 0) ? (size_t)value : 4096u;
  }
  if (bytes == 0)
    return true;

  size_t rounded_offset = offset & ~(page_size - 1);
  size_t prefix = offset - rounded_offset;
  size_t rounded_bytes = (prefix + bytes + page_size - 1) & ~(page_size - 1);
  uint8_t *commit_base = (uint8_t *)base + rounded_offset;
  return mprotect(commit_base, rounded_bytes, PROT_READ | PROT_WRITE) == 0;
}

void host_release_memory(void *base, size_t bytes) {
  if (base != NULL && bytes > 0) {
    munmap(base, bytes);
  }
}

void host_wait_u32(atomic_uint *ptr, uint32_t expected) {
#if defined(__linux__)
  syscall(SYS_futex, ptr, FUTEX_WAIT_PRIVATE, expected, NULL, NULL, 0);
#else
  while (atomic_load_explicit(ptr, memory_order_acquire) == expected) {
    sched_yield();
  }
#endif
}

void host_notify_u32(atomic_uint *ptr, uint32_t count) {
#if defined(__linux__)
  syscall(SYS_futex, ptr, FUTEX_WAKE_PRIVATE, count, NULL, NULL, 0);
#else
  (void)ptr;
  (void)count;
#endif
}

void host_sleep_ms(uint32_t timeout_ms) { usleep(timeout_ms * 1000u); }

void host_yield(void) { sched_yield(); }

uint32_t host_cpu_count(void) {
  long n = sysconf(_SC_NPROCESSORS_ONLN);
  if (n > 0 && n <= 0xffffffffu) {
    return (uint32_t)n;
  }
  return 4;
}

uint32_t host_process_id(void) { return (uint32_t)getpid(); }

uint64_t host_monotonic_time_ns(void) {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return (uint64_t)ts.tv_sec * 1000000000ULL + (uint64_t)ts.tv_nsec;
}

bool host_path_openable_for_read(const char *path) {
  int fd = open(path, O_RDONLY | O_NONBLOCK);
  if (fd < 0) {
    return false;
  }
  close(fd);
  return true;
}

bool host_runtime_input_open(const char *path) {
  host_runtime_input_close();
  runtime_stdin_fd = open(path, O_RDONLY | O_NONBLOCK);
  return runtime_stdin_fd >= 0;
}

int host_runtime_input_read_byte(uint8_t *byte_out) {
  ssize_t n = read(runtime_stdin_fd, byte_out, 1);
  if (n == 1) {
    return 1;
  }
  if (n == 0) {
    return 0;
  }
  if (errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR) {
    return 0;
  }
  return -1;
}

void host_runtime_input_close(void) {
  if (runtime_stdin_fd >= 0) {
    close(runtime_stdin_fd);
    runtime_stdin_fd = -1;
  }
}

HostFileMapResult host_map_input_file(const char *path,
                                      HostFileMapping *mapping) {
  memset(mapping, 0, sizeof(*mapping));
  mapping->fd = open(path, O_RDONLY);
  if (mapping->fd < 0) {
    return HOST_FILE_MAP_OPEN_FAILED;
  }

  struct stat st;
  if (fstat(mapping->fd, &st) != 0) {
    close(mapping->fd);
    mapping->fd = -1;
    return HOST_FILE_MAP_STAT_FAILED;
  }

  mapping->size = (size_t)st.st_size;
  if (mapping->size == 0) {
    return HOST_FILE_MAP_OK;
  }

  mapping->data =
      mmap(NULL, mapping->size, PROT_READ, MAP_SHARED, mapping->fd, 0);
  if (mapping->data == MAP_FAILED) {
    close(mapping->fd);
    mapping->fd = -1;
    mapping->data = NULL;
    return HOST_FILE_MAP_MAP_FAILED;
  }
  mapping->writable = false;
  return HOST_FILE_MAP_OK;
}

HostFileMapResult host_map_output_file(const char *path, size_t size,
                                       HostFileMapping *mapping) {
  memset(mapping, 0, sizeof(*mapping));
  mapping->fd = open(path, O_RDWR | O_CREAT | O_TRUNC, 0666);
  if (mapping->fd < 0) {
    return HOST_FILE_MAP_OPEN_FAILED;
  }

  if (ftruncate(mapping->fd, (off_t)size) != 0) {
    close(mapping->fd);
    mapping->fd = -1;
    return HOST_FILE_MAP_TRUNCATE_FAILED;
  }

  mapping->size = size;
  mapping->data =
      mmap(NULL, size, PROT_READ | PROT_WRITE, MAP_SHARED, mapping->fd, 0);
  if (mapping->data == MAP_FAILED) {
    close(mapping->fd);
    mapping->fd = -1;
    mapping->data = NULL;
    return HOST_FILE_MAP_MAP_FAILED;
  }
  mapping->writable = true;
  return HOST_FILE_MAP_OK;
}

void host_close_file_mapping(HostFileMapping *mapping) {
  if (mapping->data != NULL && mapping->size > 0) {
    munmap(mapping->data, mapping->size);
  }
  if (mapping->fd >= 0) {
    close(mapping->fd);
  }
  memset(mapping, 0, sizeof(*mapping));
  mapping->fd = -1;
}

bool host_finish_output_file(HostFileMapping *mapping, size_t written) {
  bool ok = true;
  if (mapping->data != NULL && written > 0) {
    ok = msync(mapping->data, written, MS_SYNC) == 0;
  }
  if (mapping->data != NULL && mapping->size > 0) {
    munmap(mapping->data, mapping->size);
    mapping->data = NULL;
  }
  if (mapping->fd >= 0) {
    if (ftruncate(mapping->fd, (off_t)written) != 0) {
      ok = false;
    }
    close(mapping->fd);
    mapping->fd = -1;
  }
  mapping->size = 0;
  return ok;
}

#else

typedef int host_platform_posix_translation_unit_placeholder;

#endif
