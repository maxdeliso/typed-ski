.PHONY: build test coverage \
	build-wasm build-native print-wasm \
	format format-check lint \
	dist clean \
	format-c-internal format-nix-internal format-check-nix-internal \
	thanatos-check thanatos-tsan-repl thanatos-ubsan-repl

# Configuration
NIX_FLAGS := --extra-experimental-features 'nix-command flakes'
PORT ?= 8080
MUSL_GCC ?= musl-gcc
C_WARN_FLAGS := -Wall -Wextra -Wpedantic -Wstrict-prototypes -Werror
C_FEATURE_FLAGS := -D_GNU_SOURCE -D_DEFAULT_SOURCE -D_POSIX_C_SOURCE=199309L
C_COMMON_FLAGS := $(C_WARN_FLAGS) -pthread -std=c11 $(C_FEATURE_FLAGS)
C_RELEASE_FLAGS := -O3
C_ASAN_FLAGS := -g -O1 -fsanitize=address -fno-omit-frame-pointer
C_LSAN_FLAGS := -g -O1 -fsanitize=leak -fno-omit-frame-pointer
C_DEBUG_FLAGS := -g -O1
C_TSAN_FLAGS := -g -O1 -fsanitize=thread
C_UBSAN_FLAGS := -g -O1 -fsanitize=undefined

WASM_OPT_CFLAGS := -O3 -flto -ffunction-sections -fdata-sections -msimd128
WASM_OPT_LDFLAGS := -Wl,--gc-sections

NATIVE_OPT_CFLAGS := -O3 -flto -ffunction-sections -fdata-sections -march=native
NATIVE_OPT_LDFLAGS := -Wl,--gc-sections -static

MUSL_SOURCES := arena.c thanatos.c ski_io.c main.c performance_test.c
MUSL_OBJS := $(addprefix obj/,$(MUSL_SOURCES:.c=.o))

THANATOS_OBJS := obj/arena.o obj/thanatos.o obj/ski_io.o obj/main.o
THANATOS_TEST_OBJS := obj/arena.o obj/thanatos.o obj/performance_test.o

# Helper to resolve MUSL include path
MUSL_INC := $(shell echo $(MUSL_GCC) | sed "s|/bin/musl-gcc|/include|")

obj/%.o: c/%.c
	mkdir -p obj
	$(CC) $(NATIVE_OPT_CFLAGS) $(C_COMMON_FLAGS) -fno-lto -fno-stack-protector -U_FORTIFY_SOURCE -D_FORTIFY_SOURCE=0 -isystem $(MUSL_INC) -c $< -o $@

bin/thanatos: $(THANATOS_OBJS)
	mkdir -p bin
	$(MUSL_GCC) $(NATIVE_OPT_CFLAGS) -static -Wl,--gc-sections $^ -o $@

bin/thanatos-test: $(THANATOS_TEST_OBJS)
	mkdir -p bin
	$(MUSL_GCC) $(NATIVE_OPT_CFLAGS) -static -Wl,--gc-sections $^ -o $@

bin/thanatos-test-lsan: c/arena.c c/thanatos.c c/performance_test.c
	mkdir -p bin
	$(CC) $(C_LSAN_FLAGS) $(C_COMMON_FLAGS) $^ -o $@

bin/thanatos-test-ubsan: c/arena.c c/thanatos.c c/performance_test.c
	mkdir -p bin
	$(CC) $(C_UBSAN_FLAGS) $(C_COMMON_FLAGS) $^ -o $@

bin/thanatos-asan: c/arena.c c/thanatos.c c/ski_io.c c/main.c
	mkdir -p bin
	$(CC) $(C_ASAN_FLAGS) $(C_COMMON_FLAGS) $^ -o $@

bin/thanatos-lsan: c/arena.c c/thanatos.c c/ski_io.c c/main.c
	mkdir -p bin
	$(CC) $(C_LSAN_FLAGS) $(C_COMMON_FLAGS) $^ -o $@

bin/thanatos-debug: c/arena.c c/thanatos.c c/ski_io.c c/main.c
	mkdir -p bin
	$(CC) $(C_DEBUG_FLAGS) $(C_COMMON_FLAGS) $^ -o $@

# Nix development shell wrapper
NIX_RUN := nix $(NIX_FLAGS) develop --command $(MAKE)

help:
	@echo "Available targets (automatically wrapped in nix develop):"
	@echo "  build        - Compile all artifacts"
	@echo "  test         - Run the test suite"
	@echo "  coverage     - Generate coverage.lcov"
	@echo "  clean        - Remove build artifacts"
	@echo "  build-wasm   - Build the WASM module from C"
	@echo "  build-native - Build all native binaries (release, asan, lsan, debug)"
	@echo "  thanatos-check - Run native thanatos-test smoke check"
	@echo "  thanatos-tsan-repl - Build REPL with ThreadSanitizer (data races)"
	@echo "  thanatos-ubsan-repl - Build REPL with UBSan (undefined behaviour)"
	@echo "  print-wasm   - Print WASM artifact details"
	@echo "  format       - Format code"
	@echo "  start        - Start the profiling demo server (PORT=$(PORT))"

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

thanatos-check:
	$(NIX_RUN) thanatos-check-internal

print-wasm:
	$(NIX_RUN) print-wasm-internal

format:
	$(NIX_RUN) format-internal

format-check:
	$(NIX_RUN) format-check-internal

start:
	$(NIX_RUN) start-internal

# Internal targets (assume they are running inside nix develop)
build-internal: build-wasm-internal build-native-internal
	nix $(NIX_FLAGS) run .#verify-version
	nix $(NIX_FLAGS) run .#generate-version-ts
	deno run -A scripts/generate-arena-header-c.ts
	deno task dist

test-internal: build-wasm-internal
	deno run -A scripts/generate-arena-header-c.ts
	$(MAKE) format-check-internal
	nix $(NIX_FLAGS) run .#lint
	nix $(NIX_FLAGS) run .#test

coverage-internal: build-wasm-internal
	deno run -A scripts/generate-arena-header-c.ts
	deno task test:coverage
	deno task coverage:lcov

clean-internal:
	rm -rf bin/ obj/ wasm/ dist/ coverage/

build-wasm-internal:
	mkdir -p wasm
	$$WASM_CC -fuse-ld=$$WASM_LD --target=wasm32 $(WASM_OPT_CFLAGS) -nostdlib \
		-Wl,--no-entry -Wl,--export-all -Wl,--import-memory -Wl,--shared-memory \
		-Wl,--max-memory=4294967296 $(WASM_OPT_LDFLAGS) \
		-matomics -mbulk-memory -mmutable-globals \
		-isystem $$WASM_RESOURCE_DIR/include \
		-o wasm/release.wasm c/arena.c

build-native-internal: bin/thanatos bin/thanatos-test bin/thanatos-test-lsan \
	bin/thanatos-test-ubsan bin/thanatos-asan bin/thanatos-lsan bin/thanatos-debug

thanatos-check-internal: build-native-internal
	timeout 30s ./bin/thanatos-test 2 65536 1024 4 512 150376326

thanatos-tsan-repl: build-native-internal
	mkdir -p bin
	$$CC $(C_TSAN_FLAGS) $(C_COMMON_FLAGS) -o bin/thanatos-tsan-repl c/arena.c c/thanatos.c c/ski_io.c c/main.c

thanatos-ubsan-repl: build-native-internal
	mkdir -p bin
	$$CC $(C_UBSAN_FLAGS) $(C_COMMON_FLAGS) -o bin/thanatos-ubsan-repl c/arena.c c/thanatos.c c/ski_io.c c/main.c

format-internal:
	nix $(NIX_FLAGS) run .#fmt
	$(MAKE) format-c-internal
	$(MAKE) format-nix-internal

format-c-internal:
	clang-format -i c/*.c c/*.h

format-nix-internal:
	nixpkgs-fmt flake.nix

format-check-internal:
	nix $(NIX_FLAGS) run .#fmt -- --check
	$(MAKE) format-check-nix-internal

format-check-nix-internal:
	nixpkgs-fmt --check flake.nix

start-internal:
	deno run --allow-net --allow-read --allow-env --allow-run server/serveWorkbench.ts $(PORT)

print-wasm-internal: build-wasm-internal
	@echo "=== Local WASM artifacts ==="
	@ls -lh wasm/release.wasm
	@echo ""
	@echo "=== release.wasm section headers (llvm-objdump from nix) ==="
	@$$LLVM_OBJDUMP -h wasm/release.wasm
	@echo ""
	@echo "=== release.wasm as WAT (wasm2wat from nix) ==="
	@$$WASM2WAT --enable-threads wasm/release.wasm
