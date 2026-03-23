.PHONY: all build test coverage bundle \
	build-wasm build-native print-wasm hash-perf-experiment hash-bucket-experiment \
	format format-check lint \
	dist clean \
	format-c-internal format-nix-internal format-check-nix-internal \
	thanatos-check thanatos-check-lsan thanatos-check-ubsan thanatos-check-asan \
	thanatos-check-lsan-long thanatos-check-ubsan-long thanatos-check-asan-long \
	thanatos-tsan-repl thanatos-ubsan-repl \
	coverage-lcov-internal hash-perf-experiment-internal \
	hash-bucket-experiment-internal

all: build

NIX_FLAGS := --extra-experimental-features 'nix-command flakes'
PORT ?= 8080
MUSL_GCC ?= musl-gcc
MUSL_INC ?= /usr/include
WRAPPED_CC ?= clang
C_WARN_FLAGS := -Wall -Wextra -Wpedantic -Wstrict-prototypes -Werror
CLANG_RESOURCE_DIR ?= /usr/lib/clang/21
C_FEATURE_FLAGS := -D_GNU_SOURCE -D_DEFAULT_SOURCE -D_POSIX_C_SOURCE=199309L
C_COMMON_FLAGS := $(C_WARN_FLAGS) -pthread -std=c11 $(C_FEATURE_FLAGS) \
                   -isystem $(CLANG_RESOURCE_DIR)/include
C_DEBUG_TRAP_FLAGS := -DARENA_DEBUG_TRAP_ON_CONTROL_PTR=1
C_RELEASE_FLAGS := -O3
C_ASAN_FLAGS := -g -O1 -fsanitize=address -fno-omit-frame-pointer $(C_DEBUG_TRAP_FLAGS)
C_LSAN_FLAGS := -g -O1 -fsanitize=leak -fno-omit-frame-pointer $(C_DEBUG_TRAP_FLAGS)
C_DEBUG_FLAGS := -g -O1 $(C_DEBUG_TRAP_FLAGS)
C_TSAN_FLAGS := -g -O1 -fsanitize=thread
C_UBSAN_FLAGS := -g -O1 -fsanitize=undefined $(C_DEBUG_TRAP_FLAGS)
C_COVERAGE_FLAGS := -g -Og --coverage $(C_DEBUG_TRAP_FLAGS)

WASM_OPT ?= wasm-opt
WASM_OPT_CFLAGS := -O3 -flto -ffunction-sections -fdata-sections
WASM_OPT_LDFLAGS := -Wl,--gc-sections
WASM_EXPORT_FLAGS := \
	-Wl,--export=initArena \
	-Wl,--export=connectArena \
	-Wl,--export=reset \
	-Wl,--export=kindOf \
	-Wl,--export=symOf \
	-Wl,--export=leftOf \
	-Wl,--export=rightOf \
	-Wl,--export=allocTerminal \
	-Wl,--export=allocU8 \
	-Wl,--export=allocCons \
	-Wl,--export=arenaKernelStep \
	-Wl,--export=reduce \
	-Wl,--export=hostPullV2 \
	-Wl,--export=hostSubmit \
	-Wl,--export=workerLoop \
	-Wl,--export=debugGetArenaBaseAddr \
	-Wl,--export=getArenaMode \
	-Wl,--export=debugCalculateArenaSize \
	-Wl,--export=debugLockState \
	-Wl,--export=debugGetRingEntries
WASM_OPT_POST_FLAGS := -Oz --strip-producers --strip-target-features

NATIVE_OPT_CFLAGS := -O3 -flto -ffunction-sections -fdata-sections -march=native
NATIVE_OPT_LDFLAGS := -Wl,--gc-sections -static

MUSL_SOURCES := arena.c thanatos.c ski_io.c util.c main.c performance_test.c
MUSL_OBJS := $(addprefix obj/,$(MUSL_SOURCES:.c=.o))
C_HEADERS := $(wildcard core/*.h)

CORE_SRCS := arena.c thanatos.c ski_io.c util.c session.c main.c
CORE_PATHS := $(addprefix core/,$(CORE_SRCS))
CORE_OBJS := $(addprefix obj/,$(CORE_SRCS:.c=.o))
CORE_COV_OBJS := $(addprefix obj/coverage/,$(CORE_SRCS:.c=.o))

THANATOS_OBJS := $(CORE_OBJS)
THANATOS_TEST_OBJS := obj/arena.o obj/thanatos.o obj/performance_test.o

obj/%.o: core/%.c $(C_HEADERS)
	mkdir -p obj
	$(CC) $(NATIVE_OPT_CFLAGS) $(C_COMMON_FLAGS) -fno-lto -fno-stack-protector \
		-U_FORTIFY_SOURCE -D_FORTIFY_SOURCE=0 -isystem $(MUSL_INC) -c $< -o $@

bin/thanatos: $(THANATOS_OBJS)
	mkdir -p bin
	$(MUSL_GCC) $(NATIVE_OPT_CFLAGS) -static -Wl,--gc-sections $^ -o $@

bin/thanatos-test: $(THANATOS_TEST_OBJS)
	mkdir -p bin
	$(MUSL_GCC) $(NATIVE_OPT_CFLAGS) -static -Wl,--gc-sections $^ -o $@

bin/thanatos-test-lsan: core/arena.c core/thanatos.c core/performance_test.c $(C_HEADERS)
	mkdir -p bin
	$(WRAPPED_CC) $(C_LSAN_FLAGS) $(C_WARN_FLAGS) -pthread -std=c11 $(C_FEATURE_FLAGS) $(filter %.c,$^) -o $@

bin/thanatos-test-ubsan: core/arena.c core/thanatos.c core/performance_test.c $(C_HEADERS)
	mkdir -p bin
	$(WRAPPED_CC) $(C_UBSAN_FLAGS) $(C_WARN_FLAGS) -pthread -std=c11 $(C_FEATURE_FLAGS) $(filter %.c,$^) -o $@

bin/thanatos-test-asan: core/arena.c core/thanatos.c core/performance_test.c $(C_HEADERS)
	mkdir -p bin
	$(WRAPPED_CC) $(C_ASAN_FLAGS) $(C_WARN_FLAGS) -pthread -std=c11 $(C_FEATURE_FLAGS) $(filter %.c,$^) -o $@

bin/session-test: core/arena.c core/thanatos.c core/ski_io.c core/session.c core/util.c core/session_test.c $(C_HEADERS)
	mkdir -p bin
	$(WRAPPED_CC) $(C_DEBUG_FLAGS) $(C_WARN_FLAGS) -pthread -std=c11 $(C_FEATURE_FLAGS) $(filter %.c,$^) -o $@

bin/ski-io-test: core/arena.c core/thanatos.c core/ski_io.c core/util.c core/ski_io_test.c $(C_HEADERS)
	mkdir -p bin
	$(WRAPPED_CC) $(C_DEBUG_FLAGS) $(C_WARN_FLAGS) -pthread -std=c11 $(C_FEATURE_FLAGS) $(filter %.c,$^) -o $@

bin/util-test: core/util.c core/util_test.c $(C_HEADERS)
	mkdir -p bin
	$(WRAPPED_CC) $(C_DEBUG_FLAGS) $(C_WARN_FLAGS) -pthread -std=c11 $(C_FEATURE_FLAGS) $(filter %.c,$^) -o $@

bin/thanatos-asan: $(CORE_PATHS) $(C_HEADERS)
	mkdir -p bin
	$(WRAPPED_CC) $(C_ASAN_FLAGS) $(C_WARN_FLAGS) -pthread -std=c11 $(C_FEATURE_FLAGS) $(filter %.c,$^) -o $@

bin/thanatos-lsan: $(CORE_PATHS) $(C_HEADERS)
	mkdir -p bin
	$(WRAPPED_CC) $(C_LSAN_FLAGS) $(C_WARN_FLAGS) -pthread -std=c11 $(C_FEATURE_FLAGS) $(filter %.c,$^) -o $@

bin/thanatos-debug: $(CORE_PATHS) $(C_HEADERS)
	mkdir -p bin
	$(WRAPPED_CC) $(C_DEBUG_FLAGS) $(C_WARN_FLAGS) -pthread -std=c11 $(C_FEATURE_FLAGS) $(filter %.c,$^) -o $@

obj/coverage/%.o: core/%.c $(C_HEADERS)
	mkdir -p obj/coverage
	$(WRAPPED_CC) $(C_COVERAGE_FLAGS) $(C_WARN_FLAGS) -pthread -std=c11 $(C_FEATURE_FLAGS) -U_FORTIFY_SOURCE -D_FORTIFY_SOURCE=0 -c $< -o $@

bin/thanatos-coverage: $(CORE_COV_OBJS)
	mkdir -p bin
	$(WRAPPED_CC) $(C_COVERAGE_FLAGS) $^ -pthread -o $@

bin/dag-codec-test: core/arena.c core/ski_io.c core/util.c core/dag_codec_test.c $(C_HEADERS)
	mkdir -p bin
	$(WRAPPED_CC) $(C_DEBUG_FLAGS) $(C_WARN_FLAGS) -pthread -std=c11 $(C_FEATURE_FLAGS) $(filter %.c,$^) -o $@

# Nix development shell wrapper
# We keep essential Nix and system variables while ignoring the rest to ensure hermeticity
NIX_RUN := nix $(NIX_FLAGS) develop --ignore-environment \
	--keep NIX_PATH --keep NIX_DAEMON_SOCKET --keep NIX_CONF_DIR \
	--keep TERM --keep HOME --keep USER --keep LANG --keep SSL_CERT_FILE \
	--keep PORT \
	--command $(MAKE)

DENO_TEST_CMD ?= deno task test

GENERATED_TS_TARGETS := \
	lib/shared/version.generated.ts \
	lib/evaluator/arenaHeader.generated.ts

TRIPC_DIST_TARGETS := \
	dist/tripc.js \
	dist/tripc.min.js \
	dist/tripc.node.js \
	dist/tripc

BROWSER_DIST_TARGETS := \
	dist/webglForest.js \
	dist/workbench.js \
	dist/arenaWorker.js

DIST_TARGETS := $(TRIPC_DIST_TARGETS) $(BROWSER_DIST_TARGETS)
WASM_BUILD_STATE := .make/wasm-build-state.txt

NATIVE_BUILD_TARGETS := \
	bin/thanatos \
	bin/thanatos-test \
	bin/thanatos-test-lsan \
	bin/thanatos-test-ubsan \
	bin/thanatos-test-asan \
	bin/thanatos-asan \
	bin/thanatos-lsan \
	bin/thanatos-debug \
	bin/dag-codec-test

TRIPC_BUNDLE_SOURCES := $(shell find bin lib -type f \( -name '*.ts' -o -name '*.js' \) -print)
BROWSER_BUNDLE_SOURCES := $(shell find server lib -type f \( -name '*.ts' -o -name '*.js' \) -print)
DENO_BUILD_CONFIGS := deno.jsonc server/deno.json

# Public entry points
build:
	$(NIX_RUN) build-internal

test:
	$(NIX_RUN) test-internal

coverage:
	$(NIX_RUN) coverage-internal

clean:
	$(NIX_RUN) clean-internal

build-wasm:
	$(NIX_RUN) build-wasm-internal

build-native:
	$(NIX_RUN) build-native-internal

hash-perf-experiment:
	$(NIX_RUN) hash-perf-experiment-internal

hash-bucket-experiment:
	$(NIX_RUN) hash-bucket-experiment-internal

thanatos-check:
	$(NIX_RUN) thanatos-check-internal

thanatos-check-lsan:
	$(NIX_RUN) thanatos-check-lsan-internal

thanatos-check-ubsan:
	$(NIX_RUN) thanatos-check-ubsan-internal

thanatos-check-asan:
	$(NIX_RUN) thanatos-check-asan-internal

thanatos-check-lsan-long:
	$(NIX_RUN) thanatos-check-lsan-long-internal

thanatos-check-ubsan-long:
	$(NIX_RUN) thanatos-check-ubsan-long-internal

thanatos-check-asan-long:
	$(NIX_RUN) thanatos-check-asan-long-internal

print-wasm:
	$(NIX_RUN) print-wasm-internal

format:
	$(NIX_RUN) format-internal

format-check:
	$(NIX_RUN) format-check-internal

start:
	$(NIX_RUN) start-internal

bundle:
	$(NIX_RUN) bundle-internal

# Internal targets (assume they are running inside nix develop)
build-internal: $(NATIVE_BUILD_TARGETS) wasm/release.wasm $(GENERATED_TS_TARGETS) $(DIST_TARGETS)

$(WASM_BUILD_STATE): Makefile
	mkdir -p $(dir $@)
	@printf '%s\n' \
		'WASM_CC=$(WASM_CC)' \
		'WASM_LD=$(WASM_LD)' \
		'WASM_RESOURCE_DIR=$(WASM_RESOURCE_DIR)' \
		'WASM_OPT=$(WASM_OPT)' \
		'WASM_OPT_CFLAGS=$(WASM_OPT_CFLAGS)' \
		'WASM_OPT_LDFLAGS=$(WASM_OPT_LDFLAGS)' \
		'WASM_EXPORT_FLAGS=$(WASM_EXPORT_FLAGS)' \
		'WASM_OPT_POST_FLAGS=$(WASM_OPT_POST_FLAGS)' \
		> $@.tmp
	@if cmp -s $@.tmp $@; then rm -f $@.tmp; else mv $@.tmp $@; fi

lib/shared/version.generated.ts: deno.jsonc scripts/generateVersion.ts
	nix $(NIX_FLAGS) run .#verify-version
	nix $(NIX_FLAGS) run .#generate-version-ts

lib/evaluator/arenaHeader.generated.ts: core/arena.h scripts/generateArenaHeaderC.ts
	deno run -A scripts/generateArenaHeaderC.ts

coverage-binaries-internal: build-wasm-internal bin/thanatos-coverage
	$(WRAPPED_CC) $(C_COVERAGE_FLAGS) $(C_WARN_FLAGS) -pthread -std=c11 $(C_FEATURE_FLAGS) -U_FORTIFY_SOURCE -D_FORTIFY_SOURCE=0 \
		core/arena.c core/ski_io.c core/util.c core/dag_codec_test.c -o bin/dag-codec-coverage
	$(WRAPPED_CC) $(C_COVERAGE_FLAGS) $(C_WARN_FLAGS) -pthread -std=c11 $(C_FEATURE_FLAGS) -U_FORTIFY_SOURCE -D_FORTIFY_SOURCE=0 \
		core/arena.c core/thanatos.c core/performance_test.c -o bin/thanatos-test-coverage
	$(WRAPPED_CC) $(C_COVERAGE_FLAGS) $(C_WARN_FLAGS) -pthread -std=c11 $(C_FEATURE_FLAGS) -U_FORTIFY_SOURCE -D_FORTIFY_SOURCE=0 \
		core/arena.c core/thanatos.c core/ski_io.c core/session.c core/util.c core/session_test.c -o bin/session-coverage
	$(WRAPPED_CC) $(C_COVERAGE_FLAGS) $(C_WARN_FLAGS) -pthread -std=c11 $(C_FEATURE_FLAGS) -U_FORTIFY_SOURCE -D_FORTIFY_SOURCE=0 \
		core/arena.c core/thanatos.c core/ski_io.c core/util.c core/ski_io_test.c -o bin/ski-io-coverage
	$(WRAPPED_CC) $(C_COVERAGE_FLAGS) $(C_WARN_FLAGS) -pthread -std=c11 $(C_FEATURE_FLAGS) -U_FORTIFY_SOURCE -D_FORTIFY_SOURCE=0 \
		core/util.c core/util_test.c -o bin/util-coverage

coverage-report-internal:
	$(MAKE) coverage-lcov-internal
	printf '#!/bin/sh\nexec llvm-cov gcov "$$@"\n' > coverage-c/llvm-gcov.sh
	chmod +x coverage-c/llvm-gcov.sh
	lcov --capture --directory obj/coverage --directory . --output-file coverage-c/coverage.info --no-external --base-directory . --gcov-tool ./coverage-c/llvm-gcov.sh --ignore-errors unsupported,source
	cp coverage-c/coverage.info coverage-c.lcov

THANATOS_BIN_VAL ?= ./bin/thanatos
DAG_CODEC_TEST_BIN ?= ./bin/dag-codec-test
THANATOS_TEST_BIN ?= ./bin/thanatos-test
HASH_EXPERIMENT_SRCS := core/arena.c core/thanatos.c core/performance_test.c
HASH_EXPERIMENT_FLAGS := $(C_RELEASE_FLAGS) -ffunction-sections -fdata-sections -march=native \
	$(C_WARN_FLAGS) -pthread -std=c11 $(C_FEATURE_FLAGS)
HASH_EXPERIMENT_LDFLAGS := -Wl,--gc-sections
HASH_EXPERIMENT_ARGS ?= $(THANATOS_SHORT_ARGS)
HASH_BASELINE_DEFS := -DARENA_HASH_MIX_MODE=0 -DARENA_HASH_BUCKET_MODE=0
HASH_EXPERIMENT_BUCKET_DEFS := -DARENA_HASH_BUCKET_MODE=0

bin/thanatos-test-hash-baseline: $(HASH_EXPERIMENT_SRCS) $(C_HEADERS)
	mkdir -p bin
	$(WRAPPED_CC) $(HASH_EXPERIMENT_FLAGS) $(HASH_EXPERIMENT_LDFLAGS) \
		$(HASH_BASELINE_DEFS) $(filter %.c,$^) -o $@

bin/thanatos-test-hash-fmix32: $(HASH_EXPERIMENT_SRCS) $(C_HEADERS)
	mkdir -p bin
	$(WRAPPED_CC) $(HASH_EXPERIMENT_FLAGS) $(HASH_EXPERIMENT_LDFLAGS) \
		$(HASH_EXPERIMENT_BUCKET_DEFS) -DARENA_HASH_MIX_MODE=1 \
		$(filter %.c,$^) -o $@

bin/thanatos-test-hash-pair64: $(HASH_EXPERIMENT_SRCS) $(C_HEADERS)
	mkdir -p bin
	$(WRAPPED_CC) $(HASH_EXPERIMENT_FLAGS) $(HASH_EXPERIMENT_LDFLAGS) \
		$(HASH_EXPERIMENT_BUCKET_DEFS) -DARENA_HASH_MIX_MODE=2 \
		$(filter %.c,$^) -o $@

bin/thanatos-test-hash-stream: $(HASH_EXPERIMENT_SRCS) $(C_HEADERS)
	mkdir -p bin
	$(WRAPPED_CC) $(HASH_EXPERIMENT_FLAGS) $(HASH_EXPERIMENT_LDFLAGS) \
		$(HASH_EXPERIMENT_BUCKET_DEFS) -DARENA_HASH_MIX_MODE=3 \
		$(filter %.c,$^) -o $@

bin/thanatos-test-hash-bucket-fmix32: $(HASH_EXPERIMENT_SRCS) $(C_HEADERS)
	mkdir -p bin
	$(WRAPPED_CC) $(HASH_EXPERIMENT_FLAGS) $(HASH_EXPERIMENT_LDFLAGS) \
		-DARENA_HASH_BUCKET_MODE=1 -DARENA_HASH_MIX_MODE=0 \
		$(filter %.c,$^) -o $@

hash-perf-experiment-internal: bin/thanatos-test-hash-baseline \
	bin/thanatos-test-hash-fmix32 \
	bin/thanatos-test-hash-pair64 \
	bin/thanatos-test-hash-stream
	./bin/thanatos-test-hash-baseline $(HASH_EXPERIMENT_ARGS)
	./bin/thanatos-test-hash-fmix32 $(HASH_EXPERIMENT_ARGS)
	./bin/thanatos-test-hash-pair64 $(HASH_EXPERIMENT_ARGS)
	./bin/thanatos-test-hash-stream $(HASH_EXPERIMENT_ARGS)

hash-bucket-experiment-internal: bin/thanatos-test-hash-baseline \
	bin/thanatos-test-hash-bucket-fmix32
	./bin/thanatos-test-hash-baseline $(HASH_EXPERIMENT_ARGS)
	./bin/thanatos-test-hash-bucket-fmix32 $(HASH_EXPERIMENT_ARGS)

bundle-internal: wasm/release.wasm $(DIST_TARGETS)

dist/tripc.js: $(TRIPC_BUNDLE_SOURCES) $(GENERATED_TS_TARGETS) $(DENO_BUILD_CONFIGS) Makefile
	mkdir -p $(dir $@)
	deno bundle --no-check --platform=browser bin/tripc.ts -o $@

dist/tripc.min.js: $(TRIPC_BUNDLE_SOURCES) $(GENERATED_TS_TARGETS) $(DENO_BUILD_CONFIGS) Makefile
	mkdir -p $(dir $@)
	deno bundle --no-check --minify --platform=browser bin/tripc.ts -o $@

dist/tripc.node.js: $(TRIPC_BUNDLE_SOURCES) $(GENERATED_TS_TARGETS) $(DENO_BUILD_CONFIGS) Makefile
	mkdir -p $(dir $@)
	deno bundle --no-check --platform=browser bin/tripc.ts -o $@

dist/tripc: $(TRIPC_BUNDLE_SOURCES) $(GENERATED_TS_TARGETS) $(DENO_BUILD_CONFIGS) Makefile
	mkdir -p $(dir $@)
	deno compile --allow-read --allow-write --output $@ bin/tripc.ts

dist/webglForest.js: $(BROWSER_BUNDLE_SOURCES) $(GENERATED_TS_TARGETS) $(DENO_BUILD_CONFIGS) Makefile
	mkdir -p $(dir $@)
	deno bundle --no-check --platform=browser server/webglForest.ts -o $@

dist/workbench.js: $(BROWSER_BUNDLE_SOURCES) $(GENERATED_TS_TARGETS) $(DENO_BUILD_CONFIGS) Makefile
	mkdir -p $(dir $@)
	deno bundle --no-check --platform=browser server/workbench.js -o $@

dist/arenaWorker.js: $(BROWSER_BUNDLE_SOURCES) $(GENERATED_TS_TARGETS) $(DENO_BUILD_CONFIGS) Makefile
	mkdir -p $(dir $@)
	deno bundle --no-check --platform=browser lib/evaluator/arenaWorker.ts -o $@

test-internal: build-internal
	$(MAKE) bundle-internal
	$(MAKE) format-check-internal
	nix $(NIX_FLAGS) run .#lint
	THANATOS_BIN=$(THANATOS_BIN_VAL) $(DENO_TEST_CMD)
	$(MAKE) dag-codec-check-internal
	$(MAKE) thanatos-check-internal
	$(MAKE) thanatos-check-lsan-internal
	$(MAKE) thanatos-check-ubsan-internal
	$(MAKE) thanatos-check-asan-internal

dag-codec-check-internal: build-native-internal
	$(DAG_CODEC_TEST_BIN)

thanatos-check-internal: build-native-internal
	timeout 30s $(THANATOS_TEST_BIN) $(THANATOS_SHORT_ARGS)

coverage-internal: coverage-binaries-internal
	rm -rf coverage coverage-c
	mkdir -p coverage-c
	./bin/dag-codec-coverage
	./bin/thanatos-test-coverage $(THANATOS_SHORT_ARGS)
	./bin/session-coverage
	./bin/ski-io-coverage
	./bin/util-coverage
	$(MAKE) test-internal \
		DENO_TEST_CMD='deno task test:coverage' \
		THANATOS_BIN_VAL='./bin/thanatos-coverage' \
		DAG_CODEC_TEST_BIN='./bin/dag-codec-coverage' \
		THANATOS_TEST_BIN='./bin/thanatos-test-coverage'
	$(MAKE) coverage-report-internal

coverage-lcov-internal:
	deno task coverage:lcov

CLEAN_ARTIFACTS := \
	bin/thanatos \
	bin/thanatos-test \
	bin/thanatos-test-lsan \
	bin/thanatos-test-ubsan \
	bin/thanatos-test-asan \
	bin/thanatos-test-hash-baseline \
	bin/thanatos-test-hash-bucket-fmix32 \
	bin/thanatos-test-hash-fmix32 \
	bin/thanatos-test-hash-pair64 \
	bin/thanatos-test-hash-stream \
	bin/thanatos-asan \
	bin/thanatos-lsan \
	bin/thanatos-debug \
	bin/thanatos-coverage \
	bin/thanatos-test-coverage \
	bin/dag-codec-test \
	bin/dag-codec-coverage \
	bin/session-test \
	bin/session-coverage \
	bin/ski-io-test \
	bin/ski-io-coverage \
	bin/util-test \
	bin/util-coverage \
	obj/arena.o \
	obj/thanatos.o \
	obj/ski_io.o \
	obj/util.o \
	obj/session.o \
	obj/main.o \
	obj/performance_test.o \
	$(WASM_BUILD_STATE) \
	wasm/release.wasm \
	dist/tripc.js \
	dist/tripc.min.js \
	dist/tripc.node.js \
	dist/tripc \
	dist/webglForest.js \
	dist/workbench.js \
	dist/arenaWorker.js \
	coverage.lcov \
	coverage-c.lcov \
	lib/shared/version.generated.ts \
	lib/evaluator/arenaHeader.generated.ts

clean-internal:
	rm -f $(CLEAN_ARTIFACTS)
	-find coverage -type f -delete 2>/dev/null || true
	-find obj/coverage -type f -delete 2>/dev/null || true
	-rm *.gcda *.gcno 2>/dev/null || true
	-rmdir obj/coverage 2>/dev/null || true
	-rmdir obj wasm dist coverage coverage-c .make 2>/dev/null || true
	-rmdir bin 2>/dev/null || true

build-wasm-internal: wasm/release.wasm

wasm/release.wasm: core/arena.c $(C_HEADERS) $(WASM_BUILD_STATE)
	mkdir -p wasm
	$$WASM_CC -fuse-ld=$$WASM_LD --target=wasm32 $(WASM_OPT_CFLAGS) -nostdlib \
		-Wl,--no-entry -Wl,--import-memory -Wl,--shared-memory \
		-Wl,--max-memory=4294967296 $(WASM_OPT_LDFLAGS) \
		$(WASM_EXPORT_FLAGS) \
		-matomics -mbulk-memory -mmutable-globals \
		-isystem $$WASM_RESOURCE_DIR/include \
		-o $@ $<
	$(WASM_OPT) $(WASM_OPT_POST_FLAGS) $@ -o $@

# Fixed seed for CI and long *san tests (reproducible)
THANATOS_CI_SEED := 150376326
# Short run: 2 threads, 64k arena, 1024 reductions, depth 4, max_steps 512
THANATOS_SHORT_ARGS := 2 65536 1024 4 512 $(THANATOS_CI_SEED)
# Long run: 4 threads, 128k arena, 4096 reductions, depth 5, max_steps 1024 (for *san in CI)
THANATOS_LONG_ARGS := 4 131072 4096 5 1024 $(THANATOS_CI_SEED)

build-native-internal: $(NATIVE_BUILD_TARGETS)

thanatos-check-lsan-internal: build-native-internal
	timeout 60s ./bin/thanatos-test-lsan $(THANATOS_SHORT_ARGS)

thanatos-check-ubsan-internal: build-native-internal
	timeout 60s ./bin/thanatos-test-ubsan $(THANATOS_SHORT_ARGS)

thanatos-check-asan-internal: build-native-internal
	timeout 60s ./bin/thanatos-test-asan $(THANATOS_SHORT_ARGS)

thanatos-check-lsan-long-internal: build-native-internal
	timeout 180s ./bin/thanatos-test-lsan $(THANATOS_LONG_ARGS)

thanatos-check-ubsan-long-internal: build-native-internal
	timeout 180s ./bin/thanatos-test-ubsan $(THANATOS_LONG_ARGS)

thanatos-check-asan-long-internal: build-native-internal
	timeout 180s ./bin/thanatos-test-asan $(THANATOS_LONG_ARGS)

thanatos-tsan-repl: build-native-internal
	mkdir -p bin
	$(WRAPPED_CC) $(C_TSAN_FLAGS) $(C_WARN_FLAGS) -pthread -std=c11 $(C_FEATURE_FLAGS) -o bin/thanatos-tsan-repl \
		core/arena.c core/thanatos.c core/ski_io.c core/util.c core/session.c core/main.c

thanatos-ubsan-repl: build-native-internal
	mkdir -p bin
	$(WRAPPED_CC) $(C_UBSAN_FLAGS) $(C_WARN_FLAGS) -pthread -std=c11 $(C_FEATURE_FLAGS) -o bin/thanatos-ubsan-repl \
		core/arena.c core/thanatos.c core/ski_io.c core/util.c core/session.c core/main.c

format-internal:
	nix $(NIX_FLAGS) run .#fmt
	$(MAKE) format-c-internal
	$(MAKE) format-nix-internal
	mbake format --config .mbake.toml Makefile

format-c-internal:
	clang-format -i core/*.c core/*.h

format-nix-internal:
	nixpkgs-fmt flake.nix

format-check-internal:
	nix $(NIX_FLAGS) run .#fmt -- --check
	$(MAKE) format-check-nix-internal
	mbake validate --config .mbake.toml Makefile

format-check-nix-internal:
	nixpkgs-fmt --check flake.nix

start-internal: bundle-internal
	deno run -c deno.jsonc --allow-net --allow-read --allow-env --allow-run server/serveWorkbench.ts $(PORT)

print-wasm-internal: build-wasm-internal
	@echo "=== Local WASM artifacts ==="
	@ls -lh wasm/release.wasm
	@echo ""
	@echo "=== release.wasm section headers (llvm-objdump from nix) ==="
	@$$LLVM_OBJDUMP -h wasm/release.wasm
	@echo ""
	@echo "=== release.wasm as WAT (wasm2wat from nix) ==="
	@$$WASM2WAT --enable-threads wasm/release.wasm
