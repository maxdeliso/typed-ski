.PHONY: setup build test help
.DEFAULT_GOAL := help

# Detect OS
UNAME_S := $(shell uname -s)
NIX_CONF_DIR := $(HOME)/.config/nix
NIX_CONF_FILE := $(NIX_CONF_DIR)/nix.conf

help: ## Show this help message
	@echo "Available targets:"
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-15s\033[0m %s\n", $$1, $$2}'

setup: ## Prepare this machine by installing necessary tools
	@echo "Setting up development environment..."
	@echo "Detected OS: $(UNAME_S)"
	@bash -c '\
		OS="$(UNAME_S)"; \
		if [ "$$OS" = "Darwin" ] || [ "$$OS" = "Linux" ]; then \
			echo "$$OS detected - checking for Nix..."; \
			if command -v nix >/dev/null 2>&1; then \
				echo "Nix is already installed at: $$(which nix)"; \
			elif [ -f /nix/var/nix/profiles/default/etc/profile.d/nix.sh ]; then \
				echo "Nix appears to be installed but not in PATH."; \
				echo "Please run: . /nix/var/nix/profiles/default/etc/profile.d/nix.sh"; \
				echo "Or restart your terminal."; \
			else \
				echo "Nix not found. Installing Nix..."; \
				echo "This will download and run the Nix installer."; \
				sh <(curl -L https://nixos.org/nix/install) --daemon || true; \
				echo ""; \
				echo "If installation completed, please restart your terminal or run:"; \
				echo "  . /nix/var/nix/profiles/default/etc/profile.d/nix.sh"; \
			fi; \
		else \
			echo "Unsupported OS: $$OS"; \
			echo "Please install Nix manually from https://nixos.org/download.html"; \
			exit 1; \
		fi'
	@echo ""
	@echo "Configuring Nix experimental features..."
	@mkdir -p $(NIX_CONF_DIR)
	@bash -c '\
		CONF_FILE="$(NIX_CONF_FILE)"; \
		if [ -f "$$CONF_FILE" ]; then \
			if grep -q "experimental-features.*nix-command.*flakes" "$$CONF_FILE" 2>/dev/null; then \
				echo "Experimental features already configured in $$CONF_FILE"; \
			elif grep -q "experimental-features" "$$CONF_FILE" 2>/dev/null; then \
				echo "Updating experimental-features in $$CONF_FILE..."; \
				if sed --version >/dev/null 2>&1; then \
					sed -i "s/experimental-features = .*/experimental-features = nix-command flakes/" "$$CONF_FILE" 2>/dev/null || \
					echo "experimental-features = nix-command flakes" >> "$$CONF_FILE"; \
				else \
					sed -i "" "s/experimental-features = .*/experimental-features = nix-command flakes/" "$$CONF_FILE" 2>/dev/null || \
					echo "experimental-features = nix-command flakes" >> "$$CONF_FILE"; \
				fi; \
				echo "Configuration updated."; \
			else \
				echo "Adding experimental-features to $$CONF_FILE..."; \
				echo "experimental-features = nix-command flakes" >> "$$CONF_FILE"; \
				echo "Configuration updated."; \
			fi; \
		else \
			echo "experimental-features = nix-command flakes" > "$$CONF_FILE"; \
			echo "Created $$CONF_FILE with experimental features enabled."; \
		fi'
	@echo ""
	@echo "Setup complete! If Nix was just installed, please:"
	@echo "  1. Restart your terminal, or"
	@echo "  2. Run: . /nix/var/nix/profiles/default/etc/profile.d/nix.sh"
	@echo ""
	@echo "Then run 'make build' to compile the project."

build: ## Compile the artifacts
	@echo "Building typed-ski..."
	@if ! command -v nix >/dev/null 2>&1; then \
		echo "Error: Nix is not installed. Run 'make setup' first."; \
		exit 1; \
	fi
	@echo "Updating version and generating files..."
	@nix --extra-experimental-features 'nix-command flakes' run .#update-version 2>/dev/null || true
	@nix --extra-experimental-features 'nix-command flakes' run .#generate-cargo 2>/dev/null || true
	@nix --extra-experimental-features 'nix-command flakes' run .#generate-version-ts 2>/dev/null || true
	@echo "Building with Nix..."
	@nix --extra-experimental-features 'nix-command flakes' build
	@echo "Copying WASM files for tests..."
	@mkdir -p wasm
	@bash -c '\
		if [ -d result/wasm ] && [ -f result/wasm/debug.wasm ] && [ -f result/wasm/release.wasm ]; then \
			if cp result/wasm/*.wasm wasm/ 2>/dev/null; then \
				echo "WASM files copied successfully."; \
			elif [ -f wasm/debug.wasm ] && [ -f wasm/release.wasm ]; then \
				echo "WASM files already exist in wasm/ (skipping copy due to permissions)."; \
			else \
				echo "Error: Failed to copy WASM files and they do not exist locally."; \
				echo "You may need to run: sudo cp result/wasm/*.wasm wasm/"; \
				exit 1; \
			fi; \
		else \
			echo "Error: WASM files not found in result/wasm/. Build may have failed."; \
			exit 1; \
		fi'
	@echo "Embedding WASM bytes into TypeScript bundle..."
	@nix --extra-experimental-features 'nix-command flakes' develop --command deno run -A scripts/embed-wasm.ts
	@echo "Building dist files..."
	@export PATH="$$(nix --extra-experimental-features 'nix-command flakes' develop --command bash -c 'echo $$PATH'):$$PATH" && \
		nix --extra-experimental-features 'nix-command flakes' develop --command bash -c "deno task dist"
	@echo "Validating dist files..."
	@test -f dist/tripc.js || (echo "Error: dist/tripc.js not found" && exit 1)
	@test -f dist/tripc.min.js || (echo "Error: dist/tripc.min.js not found" && exit 1)
	@test -f dist/tripc || (echo "Error: dist/tripc binary not found" && exit 1)
	@echo ""
	@echo "Build complete! Artifacts:"
	@echo "  - WASM files: wasm/debug.wasm, wasm/release.wasm"
	@echo "  - Dist files: dist/tripc.js, dist/tripc.min.js, dist/tripc"

test: ## Run the test suite
	@echo "Running test suite..."
	@if ! command -v nix >/dev/null 2>&1; then \
		echo "Error: Nix is not installed. Run 'make setup' first."; \
		exit 1; \
	fi
	@if [ ! -f wasm/debug.wasm ] || [ ! -f wasm/release.wasm ]; then \
		echo "Error: WASM files not found. Run 'make build' first."; \
		exit 1; \
	fi
	@echo "Running Rust tests..."
	@nix --extra-experimental-features 'nix-command flakes' run .#test-rust
	@echo ""
	@echo "Checking formatting..."
	@nix --extra-experimental-features 'nix-command flakes' run .#fmt -- --check || echo "Formatting check completed (non-zero exit is expected if files need formatting)"
	@echo ""
	@echo "Running linter..."
	@nix --extra-experimental-features 'nix-command flakes' run .#lint || echo "Linting completed"
	@echo ""
	@echo "Running Deno tests..."
	@nix --extra-experimental-features 'nix-command flakes' run .#test
	@echo ""
	@echo "All tests completed!"

