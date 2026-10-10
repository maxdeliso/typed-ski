/* Measure the child, not this monitor's resident memory. Inherit binary pipes. */
#include <stdio.h>
#include <stdlib.h>

#ifdef _WIN32
#include <windows.h>
#include <psapi.h>

int main(int argc, char **argv) {
  if (argc < 2) return 2;
  /* The harness supplies a controlled executable path and decimal arguments. */
  char command[32768];
  int used = snprintf(command, sizeof(command), "\"%s\"", argv[1]);
  if (used < 0 || (size_t)used >= sizeof(command)) return 2;
  for (int i = 2; i < argc; i++) {
    int appended = snprintf(command + used, sizeof(command) - (size_t)used,
                            " \"%s\"", argv[i]);
    if (appended < 0 || (size_t)appended >= sizeof(command) - (size_t)used)
      return 2;
    used += appended;
  }
  STARTUPINFOA startup = {0};
  PROCESS_INFORMATION process = {0};
  startup.cb = sizeof(startup);
  startup.dwFlags = STARTF_USESTDHANDLES;
  startup.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
  startup.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
  startup.hStdError = GetStdHandle(STD_ERROR_HANDLE);
  LARGE_INTEGER frequency, start, stop;
  QueryPerformanceFrequency(&frequency);
  QueryPerformanceCounter(&start);
  if (!CreateProcessA(argv[1], command, NULL, NULL, TRUE, CREATE_NO_WINDOW,
                      NULL, NULL, &startup, &process)) {
    fprintf(stderr, "benchmark monitor: CreateProcess failed %lu\n",
            GetLastError());
    return 2;
  }
  WaitForSingleObject(process.hProcess, INFINITE);
  QueryPerformanceCounter(&stop);
  PROCESS_MEMORY_COUNTERS memory;
  DWORD exit_code = 2;
  if (GetProcessMemoryInfo(process.hProcess, &memory, sizeof(memory))) {
    fprintf(stderr, "benchmark monitor: peak_rss_bytes=%llu elapsed_ms=%.6f\n",
            (unsigned long long)memory.PeakWorkingSetSize,
            (double)(stop.QuadPart - start.QuadPart) * 1000.0 /
                (double)frequency.QuadPart);
  } else {
    fprintf(stderr, "benchmark monitor: GetProcessMemoryInfo failed %lu\n",
            GetLastError());
  }
  GetExitCodeProcess(process.hProcess, &exit_code);
  CloseHandle(process.hThread);
  CloseHandle(process.hProcess);
  return (int)exit_code;
}
#else
#include <sys/resource.h>
#include <sys/time.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

int main(int argc, char **argv) {
  if (argc < 2) return 2;
  struct timespec start, stop;
  clock_gettime(CLOCK_MONOTONIC, &start);
  pid_t child = fork();
  if (child < 0) return 2;
  if (child == 0) {
    execv(argv[1], argv + 1);
    _exit(127);
  }
  int status;
  struct rusage usage;
  if (wait4(child, &status, 0, &usage) < 0) return 2;
  clock_gettime(CLOCK_MONOTONIC, &stop);
#ifdef __APPLE__
  unsigned long long peak_bytes = (unsigned long long)usage.ru_maxrss;
#else
  unsigned long long peak_bytes = (unsigned long long)usage.ru_maxrss * 1024;
#endif
  double elapsed_ms = (double)(stop.tv_sec - start.tv_sec) * 1000.0 +
                      (double)(stop.tv_nsec - start.tv_nsec) / 1000000.0;
  fprintf(stderr, "benchmark monitor: peak_rss_bytes=%llu elapsed_ms=%.6f\n",
          peak_bytes, elapsed_ms);
  return WIFEXITED(status) ? WEXITSTATUS(status) : 128 + WTERMSIG(status);
}
#endif
