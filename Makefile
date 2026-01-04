.PHONY: setup build test format format-check validate-wasm start help
.DEFAULT_GOAL := help

NIX_FLAGS := --extra-experimental-features 'nix-command flakes'
PORT ?= 8080

help:
	@echo "Available targets:"
	@echo "  setup        - Prepare this machine by installing necessary tools"
	@echo "  build        - Compile the artifacts"
	@echo "  test         - Run the test suite"
	@echo "  format       - Format code"
	@echo "  format-check - Check code formatting"
	@echo "  start        - Start the profiling demo server (PORT=8080)"

setup: ## Prepare this machine by installing necessary tools
	@if ! command -v nix >/dev/null 2>&1; then \
		echo "Error: Nix is not installed or not in PATH."; \
		echo "Install Nix from: https://nixos.org/download.html"; \
		exit 1; \
	fi

build: ## Compile the artifacts
	@if ! command -v nix >/dev/null 2>&1; then \
		echo "Error: Nix is not installed. Run 'make setup' first."; \
		exit 1; \
	fi
	nix $(NIX_FLAGS) run .#verify-version
	nix $(NIX_FLAGS) run .#generate-cargo
	nix $(NIX_FLAGS) run .#generate-version-ts
	nix $(NIX_FLAGS) build
	@if [ ! -d result/wasm ] || [ ! -f result/wasm/debug.wasm ] || [ ! -f result/wasm/release.wasm ]; then \
		echo "Error: WASM files not found in result/wasm/. Build may have failed."; \
		exit 1; \
	fi
	rm -rf wasm
	ln -s result/wasm wasm
	nix $(NIX_FLAGS) develop --command deno run -A scripts/embed-wasm.ts
	nix $(NIX_FLAGS) develop --command bash -c "deno task dist"
	@if [ ! -f dist/tripc.js ] || [ ! -f dist/tripc.min.js ] || [ ! -f dist/tripc ]; then \
		echo "Error: Required dist files not found"; \
		exit 1; \
	fi

validate-wasm: ## Inspect the generated WASM (prints full wat)
	@if [ ! -f result/wasm/release.wasm ]; then \
		echo "Error: result/wasm/release.wasm not found. Run 'make build' first."; \
		exit 1; \
	fi
	nix $(NIX_FLAGS) develop --command bash -c "wasm2wat --enable-threads result/wasm/release.wasm"

test: ## Run the test suite
	@if ! command -v nix >/dev/null 2>&1; then \
		echo "Error: Nix is not installed. Run 'make setup' first."; \
		exit 1; \
	fi
	@if [ ! -f wasm/debug.wasm ] || [ ! -f wasm/release.wasm ]; then \
		echo "Error: WASM files not found. Run 'make build' first."; \
		exit 1; \
	fi
	nix $(NIX_FLAGS) run .#test-rust
	$(MAKE) format-check
	nix $(NIX_FLAGS) run .#lint
	nix $(NIX_FLAGS) run .#test

format:
	@if ! command -v nix >/dev/null 2>&1; then \
		echo "Error: Nix is not installed. Run 'make setup' first."; \
		exit 1; \
	fi
	nix $(NIX_FLAGS) run .#fmt

format-check:
	@if ! command -v nix >/dev/null 2>&1; then \
		echo "Error: Nix is not installed. Run 'make setup' first."; \
		exit 1; \
	fi
	nix $(NIX_FLAGS) run .#fmt -- --check

start: ## Start the profiling demo server
	@if ! command -v nix >/dev/null 2>&1; then \
		echo "Error: Nix is not installed. Run 'make setup' first."; \
		exit 1; \
	fi
	@if [ ! -f lib/shared/version.generated.ts ]; then \
		echo "Error: Generated source files not found. Run 'make build' first."; \
		exit 1; \
	fi
	nix $(NIX_FLAGS) develop --command deno run --allow-net --allow-read --allow-env --allow-run server/serve-workbench.ts $(PORT)
