.PHONY: build test coverage \
build-wasm build-native print-wasm \
format format-check lint \
dist \
format-c-internal format-nix-internal format-check-nix-internal \
thanatos-check thanatos-tsan-repl thanatos-ubsan-repl

.DEFAULT_GOAL := help

# Configuration
NIX_FLAGS := --extra-experimental-features 'nix-command flakes'
PORT ?= 8080
C_WARN_FLAGS := -Wall -Wextra -Wpedantic -Wstrict-prototypes -Werror
C_COMMON_FLAGS := $(C_WARN_FLAGS) -pthread -std=c11
C_RELEASE_FLAGS := -O3
C_ASAN_FLAGS := -g -O1 -fsanitize=address -fno-omit-frame-pointer
C_LSAN_FLAGS := -g -O1 -fsanitize=leak -fno-omit-frame-pointer
C_DEBUG_FLAGS := -g -O1
C_TSAN_FLAGS := -g -O1 -fsanitize=thread
C_UBSAN_FLAGS := -g -O1 -fsanitize=undefined

WASM_OPT_CFLAGS := -O3 -flto -ffunction-sections -fdata-sections -msimd128
WASM_OPT_LDFLAGS := -Wl,--gc-sections

NATIVE_OPT_CFLAGS := -O3 -flto -ffunction-sections -fdata-sections -march=native
NATIVE_OPT_LDFLAGS := -Wl,--gc-sections

# Nix development shell wrapper
NIX_RUN := nix $(NIX_FLAGS) develop --command $(MAKE)

help:
	@echo "Available targets (automatically wrapped in nix develop):"
	@echo "  build        - Compile all artifacts"
	@echo "  test         - Run the test suite"
	@echo "  coverage     - Generate coverage.lcov"
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

build-wasm-internal:
	mkdir -p wasm
	$$WASM_CC -fuse-ld=$$WASM_LD --target=wasm32 $(WASM_OPT_CFLAGS) -nostdlib \
		-Wl,--no-entry -Wl,--export-all -Wl,--import-memory -Wl,--shared-memory \
		-Wl,--max-memory=4294967296 $(WASM_OPT_LDFLAGS) \
		-matomics -mbulk-memory -mmutable-globals \
		-isystem $$WASM_RESOURCE_DIR/include \
		-o wasm/release.wasm c/arena.c

build-native-internal:
	mkdir -p bin
	$$CC $(NATIVE_OPT_CFLAGS) $(C_COMMON_FLAGS) $(NATIVE_OPT_LDFLAGS) -o bin/thanatos c/arena.c c/thanatos.c c/ski_io.c c/main.c
	$$CC $(NATIVE_OPT_CFLAGS) $(C_COMMON_FLAGS) $(NATIVE_OPT_LDFLAGS) -o bin/thanatos-test c/arena.c c/thanatos.c c/performance_test.c
	$$CC $(C_LSAN_FLAGS) $(C_COMMON_FLAGS) -o bin/thanatos-test-lsan c/arena.c c/thanatos.c c/performance_test.c
	$$CC $(C_UBSAN_FLAGS) $(C_COMMON_FLAGS) -o bin/thanatos-test-ubsan c/arena.c c/thanatos.c c/performance_test.c
	$$CC $(C_ASAN_FLAGS) $(C_COMMON_FLAGS) -o bin/thanatos-asan c/arena.c c/thanatos.c c/ski_io.c c/main.c
	$$CC $(C_LSAN_FLAGS) $(C_COMMON_FLAGS) -o bin/thanatos-lsan c/arena.c c/thanatos.c c/ski_io.c c/main.c
	$$CC $(C_DEBUG_FLAGS) $(C_COMMON_FLAGS) -o bin/thanatos-debug c/arena.c c/thanatos.c c/ski_io.c c/main.c

thanatos-check-internal: build-native-internal
	timeout 30s ./bin/thanatos-test 2 65536 1024 4 512 150376326

# Build REPL with ThreadSanitizer (detects data races; use instead of ASan for race bugs).
thanatos-tsan-repl: build-native-internal
	mkdir -p bin
	$$CC $(C_TSAN_FLAGS) $(C_COMMON_FLAGS) -o bin/thanatos-tsan-repl c/arena.c c/thanatos.c c/ski_io.c c/main.c
	@echo "Run: ./bin/thanatos-tsan-repl < c/thanatos_spin_input.txt"
	@echo "TSan will print a race report if non-determinism is from a data race."

# Build REPL with UBSan (undefined behaviour: shifts, overflow, misaligned, etc.).
thanatos-ubsan-repl: build-native-internal
	mkdir -p bin
	$$CC $(C_UBSAN_FLAGS) $(C_COMMON_FLAGS) -o bin/thanatos-ubsan-repl c/arena.c c/thanatos.c c/ski_io.c c/main.c
	@echo "Run: ./bin/thanatos-ubsan-repl < c/thanatos_spin_input.txt"

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
