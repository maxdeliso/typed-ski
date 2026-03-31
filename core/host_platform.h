#ifndef HOST_PLATFORM_H
#define HOST_PLATFORM_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdatomic.h>

#if defined(__wasm__)
typedef struct {
  int unused;
} HostMutex;

typedef struct {
  int unused;
} HostCond;

typedef int HostThread;

typedef struct {
  int unused;
} HostEvent;

typedef struct {
  void *data;
  size_t size;
  bool writable;
} HostFileMapping;
#elif defined(_WIN32)
#ifndef _CRT_SECURE_NO_WARNINGS
#define _CRT_SECURE_NO_WARNINGS
#endif
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>

typedef struct {
  CRITICAL_SECTION cs;
} HostMutex;

typedef CONDITION_VARIABLE HostCond;
typedef HANDLE HostThread;

typedef struct {
  HANDLE handle;
} HostEvent;

typedef struct {
  void *data;
  size_t size;
  HANDLE file_handle;
  HANDLE mapping_handle;
  bool writable;
} HostFileMapping;
#else
#include <pthread.h>

typedef pthread_mutex_t HostMutex;
typedef pthread_cond_t HostCond;
typedef pthread_t HostThread;

typedef struct {
  pthread_mutex_t mutex;
  pthread_cond_t cond;
  bool signaled;
} HostEvent;

typedef struct {
  void *data;
  size_t size;
  int fd;
  bool writable;
} HostFileMapping;
#endif

#ifdef _WIN32
#include <windows.h>
wchar_t *host_utf8_to_wide(const char *text);
#endif

typedef void *(*HostThreadFn)(void *);

typedef enum {
  HOST_FILE_MAP_OK = 0,
  HOST_FILE_MAP_OPEN_FAILED = 1,
  HOST_FILE_MAP_STAT_FAILED = 2,
  HOST_FILE_MAP_TRUNCATE_FAILED = 3,
  HOST_FILE_MAP_MAP_FAILED = 4,
} HostFileMapResult;

void host_mutex_init(HostMutex *mutex);
void host_mutex_destroy(HostMutex *mutex);
void host_mutex_lock(HostMutex *mutex);
void host_mutex_unlock(HostMutex *mutex);

void host_cond_init(HostCond *cond);
void host_cond_destroy(HostCond *cond);
void host_cond_signal(HostCond *cond);
void host_cond_wait(HostCond *cond, HostMutex *mutex);

void host_event_init(HostEvent *event);
void host_event_destroy(HostEvent *event);
void host_event_notify(HostEvent *event);
bool host_event_wait(HostEvent *event, uint32_t timeout_ms);

int host_thread_create(HostThread *thread, HostThreadFn fn, void *arg);
void host_thread_join(HostThread thread);

void *host_reserve_memory(size_t bytes);
bool host_commit_memory(void *base, size_t bytes, size_t *committed_bytes);
void host_release_memory(void *base, size_t bytes);

void host_wait_u32(atomic_uint *ptr, uint32_t expected);
void host_notify_u32(atomic_uint *ptr, uint32_t count);

void host_sleep_ms(uint32_t timeout_ms);
void host_yield(void);

uint32_t host_cpu_count(void);
uint32_t host_process_id(void);
uint64_t host_monotonic_time_ns(void);

bool host_path_openable_for_read(const char *path);
bool host_runtime_input_open(const char *path);
int host_runtime_input_read_byte(uint8_t *byte_out);
void host_runtime_input_close(void);

HostFileMapResult host_map_input_file(const char *path, HostFileMapping *mapping);
HostFileMapResult host_map_output_file(const char *path, size_t size,
                                       HostFileMapping *mapping);
void host_close_file_mapping(HostFileMapping *mapping);
bool host_finish_output_file(HostFileMapping *mapping, size_t written);

#endif
