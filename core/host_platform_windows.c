#ifdef _WIN32

#include "host_platform.h"

#include <errno.h>
#include <io.h>
#include <process.h>
#include <profileapi.h>
#include <stdbool.h>
#include <stdlib.h>
#include <string.h>
#include <synchapi.h>
#include <winioctl.h>

typedef struct {
  HostThreadFn fn;
  void *arg;
} HostThreadStart;

typedef BOOL(WINAPI *HostWaitOnAddressFn)(volatile VOID *Address,
                                          PVOID CompareAddress,
                                          SIZE_T AddressSize,
                                          DWORD dwMilliseconds);
typedef VOID(WINAPI *HostWakeByAddressSingleFn)(PVOID Address);
typedef VOID(WINAPI *HostWakeByAddressAllFn)(PVOID Address);

static HANDLE runtime_stdin_handle = INVALID_HANDLE_VALUE;
static HostWaitOnAddressFn host_wait_on_address_fn = NULL;
static HostWakeByAddressSingleFn host_wake_by_address_single_fn = NULL;
static HostWakeByAddressAllFn host_wake_by_address_all_fn = NULL;
static volatile long host_wait_on_address_initialized = 0;

static void host_init_wait_on_address_support(void) {
  if (InterlockedCompareExchange(&host_wait_on_address_initialized, 1, 0) == 0) {
    HMODULE kernel32 = GetModuleHandleW(L"Kernel32.dll");
    if (kernel32 != NULL) {
      host_wait_on_address_fn = (HostWaitOnAddressFn)(void *)GetProcAddress(
          kernel32, "WaitOnAddress");
      host_wake_by_address_single_fn =
          (HostWakeByAddressSingleFn)(void *)GetProcAddress(kernel32,
                                                            "WakeByAddressSingle");
      host_wake_by_address_all_fn =
          (HostWakeByAddressAllFn)(void *)GetProcAddress(kernel32,
                                                         "WakeByAddressAll");
    }
    InterlockedExchange(&host_wait_on_address_initialized, 2);
  } else {
    while (InterlockedCompareExchange(&host_wait_on_address_initialized, 2, 2) !=
           2) {
      YieldProcessor();
    }
  }
}

wchar_t *host_utf8_to_wide(const char *text) {
  if (text == NULL) {
    return NULL;
  }
  int wide_len = MultiByteToWideChar(CP_UTF8, 0, text, -1, NULL, 0);
  if (wide_len <= 0) {
    wide_len = MultiByteToWideChar(CP_ACP, 0, text, -1, NULL, 0);
    if (wide_len <= 0) {
      return NULL;
    }
    wchar_t *wide = (wchar_t *)malloc((size_t)wide_len * sizeof(wchar_t));
    if (wide == NULL) {
      return NULL;
    }
    if (MultiByteToWideChar(CP_ACP, 0, text, -1, wide, wide_len) <= 0) {
      free(wide);
      return NULL;
    }
    return wide;
  }

  wchar_t *wide = (wchar_t *)malloc((size_t)wide_len * sizeof(wchar_t));
  if (wide == NULL) {
    return NULL;
  }
  if (MultiByteToWideChar(CP_UTF8, 0, text, -1, wide, wide_len) <= 0) {
    free(wide);
    return NULL;
  }
  return wide;
}

static unsigned __stdcall host_thread_entry(void *arg) {
  HostThreadStart *start = (HostThreadStart *)arg;
  HostThreadFn fn = start->fn;
  void *fn_arg = start->arg;
  free(start);
  (void)fn(fn_arg);
  return 0;
}

static void host_set_file_sparse(HANDLE file_handle) {
  DWORD ignored = 0;
  (void)DeviceIoControl(file_handle, FSCTL_SET_SPARSE, NULL, 0, NULL, 0,
                        &ignored, NULL);
}

static bool host_set_file_size(HANDLE file_handle, size_t size) {
  LARGE_INTEGER pos;
  pos.QuadPart = (LONGLONG)size;
  if (!SetFilePointerEx(file_handle, pos, NULL, FILE_BEGIN)) {
    return false;
  }
  return SetEndOfFile(file_handle) != 0;
}

void host_mutex_init(HostMutex *mutex) { InitializeCriticalSection(&mutex->cs); }

void host_mutex_destroy(HostMutex *mutex) { DeleteCriticalSection(&mutex->cs); }

void host_mutex_lock(HostMutex *mutex) { EnterCriticalSection(&mutex->cs); }

void host_mutex_unlock(HostMutex *mutex) { LeaveCriticalSection(&mutex->cs); }

void host_cond_init(HostCond *cond) { InitializeConditionVariable(cond); }

void host_cond_destroy(HostCond *cond) { (void)cond; }

void host_cond_signal(HostCond *cond) { WakeConditionVariable(cond); }

void host_cond_wait(HostCond *cond, HostMutex *mutex) {
  SleepConditionVariableCS(cond, &mutex->cs, INFINITE);
}

void host_event_init(HostEvent *event) {
  event->handle = CreateEventW(NULL, FALSE, FALSE, NULL);
}

void host_event_destroy(HostEvent *event) {
  if (event->handle != NULL) {
    CloseHandle(event->handle);
    event->handle = NULL;
  }
}

void host_event_notify(HostEvent *event) { SetEvent(event->handle); }

bool host_event_wait(HostEvent *event, uint32_t timeout_ms) {
  DWORD wait_ms = timeout_ms == 0 ? INFINITE : timeout_ms;
  return WaitForSingleObject(event->handle, wait_ms) == WAIT_OBJECT_0;
}

int host_thread_create(HostThread *thread, HostThreadFn fn, void *arg) {
  HostThreadStart *start = (HostThreadStart *)malloc(sizeof(*start));
  if (start == NULL) {
    return ENOMEM;
  }
  start->fn = fn;
  start->arg = arg;
  uintptr_t raw = _beginthreadex(NULL, 0, host_thread_entry, start, 0, NULL);
  if (raw == 0) {
    free(start);
    return errno != 0 ? errno : 1;
  }
  *thread = (HANDLE)raw;
  return 0;
}

void host_thread_join(HostThread thread) {
  WaitForSingleObject(thread, INFINITE);
  CloseHandle(thread);
}

void *host_reserve_memory(size_t bytes) {
  return VirtualAlloc(NULL, bytes, MEM_RESERVE, PAGE_READWRITE);
}

bool host_commit_memory(void *base, size_t bytes, size_t *committed_bytes) {
  static size_t page_size = 0;
  if (page_size == 0) {
    SYSTEM_INFO info;
    GetSystemInfo(&info);
    page_size = (size_t)info.dwPageSize;
  }
  size_t current = committed_bytes == NULL ? 0 : *committed_bytes;
  if (current >= bytes) {
    return true;
  }

  size_t target = (bytes + page_size - 1) & ~(page_size - 1);
  size_t rounded_current = (current + page_size - 1) & ~(page_size - 1);
  size_t delta = target - rounded_current;
  if (delta == 0) {
    if (committed_bytes != NULL) {
      *committed_bytes = target;
    }
    return true;
  }

  uint8_t *commit_base = (uint8_t *)base + rounded_current;
  if (VirtualAlloc(commit_base, delta, MEM_COMMIT, PAGE_READWRITE) == NULL) {
    return false;
  }
  if (committed_bytes != NULL) {
    *committed_bytes = target;
  }
  return true;
}

void host_release_memory(void *base, size_t bytes) {
  (void)bytes;
  if (base != NULL) {
    VirtualFree(base, 0, MEM_RELEASE);
  }
}

void host_wait_u32(atomic_uint *ptr, uint32_t expected) {
  host_init_wait_on_address_support();
  uint32_t compare = expected;
  while (atomic_load_explicit(ptr, memory_order_acquire) == expected) {
    if (host_wait_on_address_fn != NULL) {
      (void)host_wait_on_address_fn((volatile VOID *)ptr, &compare,
                                    sizeof(compare), INFINITE);
    } else {
      SwitchToThread();
      Sleep(1);
    }
  }
}

void host_notify_u32(atomic_uint *ptr, uint32_t count) {
  host_init_wait_on_address_support();
  if (count <= 1) {
    if (host_wake_by_address_single_fn != NULL) {
      host_wake_by_address_single_fn((PVOID)ptr);
    }
  } else {
    if (host_wake_by_address_all_fn != NULL) {
      host_wake_by_address_all_fn((PVOID)ptr);
    } else if (host_wake_by_address_single_fn != NULL) {
      /* Waking only one is a safe but potentially slower fallback if 'all' is
       * missing. */
      host_wake_by_address_single_fn((PVOID)ptr);
    }
  }
}

void host_sleep_ms(uint32_t timeout_ms) { Sleep(timeout_ms); }

void host_yield(void) { Sleep(0); }

uint32_t host_cpu_count(void) {
  static uint32_t count = 0;
  if (count == 0) {
    SYSTEM_INFO info;
    GetSystemInfo(&info);
    if (info.dwNumberOfProcessors > 0) {
      count = (uint32_t)info.dwNumberOfProcessors;
    } else {
      count = 4;
    }
  }
  return count;
}

uint32_t host_process_id(void) { return (uint32_t)GetCurrentProcessId(); }

uint64_t host_monotonic_time_ns(void) {
  static LARGE_INTEGER freq = {0};
  if (freq.QuadPart == 0) {
    QueryPerformanceFrequency(&freq);
  }
  LARGE_INTEGER counter;
  QueryPerformanceCounter(&counter);
  /* Use split calculation to avoid overflow of (counter * 1e9) for large
   * uptimes. */
  uint64_t seconds = (uint64_t)(counter.QuadPart / freq.QuadPart);
  uint64_t fractions = (uint64_t)(counter.QuadPart % freq.QuadPart);
  return (seconds * 1000000000ULL) + (fractions * 1000000000ULL) / freq.QuadPart;
}

bool host_path_openable_for_read(const char *path) {
  wchar_t *wide = host_utf8_to_wide(path);
  if (wide == NULL) {
    return false;
  }
  HANDLE handle =
      CreateFileW(wide, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, NULL,
                  OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
  free(wide);
  if (handle == INVALID_HANDLE_VALUE) {
    return false;
  }
  CloseHandle(handle);
  return true;
}

bool host_runtime_input_open(const char *path) {
  host_runtime_input_close();
  wchar_t *wide = host_utf8_to_wide(path);
  if (wide == NULL) {
    return false;
  }
  runtime_stdin_handle =
      CreateFileW(wide, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, NULL,
                  OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
  free(wide);
  return runtime_stdin_handle != INVALID_HANDLE_VALUE;
}

int host_runtime_input_read_byte(uint8_t *byte_out) {
  DWORD bytes_read = 0;
  if (!ReadFile(runtime_stdin_handle, byte_out, 1, &bytes_read, NULL)) {
    DWORD err = GetLastError();
    if (err == ERROR_BROKEN_PIPE || err == ERROR_HANDLE_EOF) {
      return 0;
    }
    return -1;
  }
  if (bytes_read == 1) {
    return 1;
  }
  return 0;
}

void host_runtime_input_close(void) {
  if (runtime_stdin_handle != INVALID_HANDLE_VALUE) {
    CloseHandle(runtime_stdin_handle);
    runtime_stdin_handle = INVALID_HANDLE_VALUE;
  }
}

HostFileMapResult host_map_input_file(const char *path,
                                      HostFileMapping *mapping) {
  memset(mapping, 0, sizeof(*mapping));
  mapping->file_handle = INVALID_HANDLE_VALUE;
  wchar_t *wide = host_utf8_to_wide(path);
  if (wide == NULL) {
    return HOST_FILE_MAP_OPEN_FAILED;
  }
  mapping->file_handle =
      CreateFileW(wide, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, NULL,
                  OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
  free(wide);
  if (mapping->file_handle == INVALID_HANDLE_VALUE) {
    return HOST_FILE_MAP_OPEN_FAILED;
  }

  LARGE_INTEGER size;
  if (!GetFileSizeEx(mapping->file_handle, &size)) {
    CloseHandle(mapping->file_handle);
    mapping->file_handle = INVALID_HANDLE_VALUE;
    return HOST_FILE_MAP_STAT_FAILED;
  }
  mapping->size = (size_t)size.QuadPart;
  if (mapping->size == 0) {
    return HOST_FILE_MAP_OK;
  }

  mapping->mapping_handle = CreateFileMappingW(mapping->file_handle, NULL,
                                               PAGE_READONLY, 0, 0, NULL);
  if (mapping->mapping_handle == NULL) {
    CloseHandle(mapping->file_handle);
    mapping->file_handle = INVALID_HANDLE_VALUE;
    return HOST_FILE_MAP_MAP_FAILED;
  }

  mapping->data = MapViewOfFile(mapping->mapping_handle, FILE_MAP_READ, 0, 0,
                                mapping->size);
  if (mapping->data == NULL) {
    CloseHandle(mapping->mapping_handle);
    CloseHandle(mapping->file_handle);
    mapping->mapping_handle = NULL;
    mapping->file_handle = INVALID_HANDLE_VALUE;
    return HOST_FILE_MAP_MAP_FAILED;
  }
  mapping->writable = false;
  return HOST_FILE_MAP_OK;
}

HostFileMapResult host_map_output_file(const char *path, size_t size,
                                       HostFileMapping *mapping) {
  memset(mapping, 0, sizeof(*mapping));
  mapping->file_handle = INVALID_HANDLE_VALUE;
  wchar_t *wide = host_utf8_to_wide(path);
  if (wide == NULL) {
    return HOST_FILE_MAP_OPEN_FAILED;
  }
  mapping->file_handle =
      CreateFileW(wide, GENERIC_READ | GENERIC_WRITE,
                  FILE_SHARE_READ | FILE_SHARE_WRITE, NULL, CREATE_ALWAYS,
                  FILE_ATTRIBUTE_NORMAL, NULL);
  free(wide);
  if (mapping->file_handle == INVALID_HANDLE_VALUE) {
    return HOST_FILE_MAP_OPEN_FAILED;
  }

  host_set_file_sparse(mapping->file_handle);
  if (!host_set_file_size(mapping->file_handle, size)) {
    CloseHandle(mapping->file_handle);
    mapping->file_handle = INVALID_HANDLE_VALUE;
    return HOST_FILE_MAP_TRUNCATE_FAILED;
  }

  mapping->mapping_handle = CreateFileMappingW(
      mapping->file_handle, NULL, PAGE_READWRITE,
      (DWORD)(((uint64_t)size >> 32) & 0xffffffffu),
      (DWORD)((uint64_t)size & 0xffffffffu), NULL);
  if (mapping->mapping_handle == NULL) {
    CloseHandle(mapping->file_handle);
    mapping->file_handle = INVALID_HANDLE_VALUE;
    return HOST_FILE_MAP_MAP_FAILED;
  }

  mapping->data =
      MapViewOfFile(mapping->mapping_handle, FILE_MAP_WRITE, 0, 0, size);
  if (mapping->data == NULL) {
    CloseHandle(mapping->mapping_handle);
    CloseHandle(mapping->file_handle);
    mapping->mapping_handle = NULL;
    mapping->file_handle = INVALID_HANDLE_VALUE;
    return HOST_FILE_MAP_MAP_FAILED;
  }
  mapping->size = size;
  mapping->writable = true;
  return HOST_FILE_MAP_OK;
}

void host_close_file_mapping(HostFileMapping *mapping) {
  if (mapping->data != NULL) {
    UnmapViewOfFile(mapping->data);
  }
  if (mapping->mapping_handle != NULL) {
    CloseHandle(mapping->mapping_handle);
  }
  if (mapping->file_handle != INVALID_HANDLE_VALUE) {
    CloseHandle(mapping->file_handle);
  }
  memset(mapping, 0, sizeof(*mapping));
  mapping->file_handle = INVALID_HANDLE_VALUE;
}

bool host_finish_output_file(HostFileMapping *mapping, size_t written) {
  bool ok = true;
  if (mapping->data != NULL && written > 0) {
    ok = FlushViewOfFile(mapping->data, written) != 0;
  }
  if (mapping->data != NULL) {
    UnmapViewOfFile(mapping->data);
    mapping->data = NULL;
  }
  if (mapping->mapping_handle != NULL) {
    CloseHandle(mapping->mapping_handle);
    mapping->mapping_handle = NULL;
  }
  if (!host_set_file_size(mapping->file_handle, written)) {
    ok = false;
  }
  if (mapping->file_handle != INVALID_HANDLE_VALUE) {
    FlushFileBuffers(mapping->file_handle);
    CloseHandle(mapping->file_handle);
    mapping->file_handle = INVALID_HANDLE_VALUE;
  }
  mapping->size = 0;
  return ok;
}

#endif
