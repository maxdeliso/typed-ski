{
  description = "typed-ski: SKI calculus implementation with Rust WASM core";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
    rust-overlay = {
      url = "github:oxalica/rust-overlay";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = { self, nixpkgs, flake-utils, rust-overlay }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        overlays = [ (import rust-overlay) ];
        pkgs = import nixpkgs { inherit system overlays; };

        # Read version from deno.jsonc
        denoJson = builtins.fromJSON (builtins.readFile ./deno.jsonc);
        version = denoJson.version;

        # Use nightly toolchain to enable unstable WASM atomic wait features.
        rustToolchain = pkgs.rust-bin.nightly.latest.default.override {
          targets = [ "wasm32-unknown-unknown" ];
        };

        deno = pkgs.deno;

        # --- Helper Scripts ---

        verifyVersion = pkgs.writeShellScriptBin "verify-version" ''
          if ! ${pkgs.jq}/bin/jq -e '.version' deno.jsonc >/dev/null 2>&1; then
            echo "Error: version field is required in deno.jsonc"
            exit 1
          fi
          echo "Version in deno.jsonc: $(${pkgs.jq}/bin/jq -r '.version' deno.jsonc)"
        '';

        generateCargoToml = pkgs.writeShellScriptBin "generate-cargo-toml" ''
          mkdir -p rust
          cat > rust/Cargo.toml << EOF
          [package]
          name = "typed-ski"
          version = "${version}"
          edition = "2021"
          authors = ["Max DeLiso <me@maxdeliso.name>"]
          license = "MIT"
          description = "SKI calculus evaluator in Rust compiled to WASM"
          repository = "https://github.com/maxdeliso/typed-ski"
          homepage = "https://github.com/maxdeliso/typed-ski"
          readme = "README.md"
          keywords = ["ski", "calculus", "wasm", "combinator"]
          categories = ["wasm", "no-std"]

          [lib]
          crate-type = ["cdylib", "rlib"]

          [profile.release]
          opt-level = "z"
          lto = true
          strip = true
          panic = "abort"

          [profile.dev]
          panic = "abort"

          [dependencies]
          # No dependencies!
          EOF
          echo "Generated rust/Cargo.toml with version ${version}"
        '';

        generateVersionTs = pkgs.writeShellScriptBin "generate-version-ts" ''
          mkdir -p lib/shared
          cat > lib/shared/version.generated.ts << EOF
          export const VERSION = "${version}";
          EOF
          echo "Generated lib/shared/version.generated.ts"
        '';

        # --- Main Build Derivation ---
        typedSki = pkgs.stdenv.mkDerivation {
          name = "typed-ski";
          inherit version;

          src = ./.;

          nativeBuildInputs = [
            rustToolchain
            deno
            pkgs.jq
            pkgs.wabt
            verifyVersion
            generateCargoToml
            generateVersionTs
          ];

          buildPhase = ''
            verify-version
            generate-cargo-toml
            generate-version-ts

            cd rust

            # RUSTFLAGS:
            # 1. Enable atomics features so our code can use them.
            # 2. Pass --no-check-features to linker so it accepts the pre-compiled libcore
            #    (which lacks 'atomics' feature) without error.
            export RUSTFLAGS="-C link-arg=--import-memory -C link-arg=--shared-memory -C link-arg=--max-memory=4294967296 -C target-feature=+atomics,+bulk-memory,+mutable-globals -C link-arg=--no-check-features"

            echo "Building WASM (debug)..."
            # Standard build (no build-std needed)
            cargo build --target wasm32-unknown-unknown --lib

            echo "Building WASM (release)..."
            cargo build --release --target wasm32-unknown-unknown --lib

            echo "Copying WASM files..."
            mkdir -p ../wasm
            cp target/wasm32-unknown-unknown/debug/typed_ski.wasm ../wasm/debug.wasm
            cp target/wasm32-unknown-unknown/release/typed_ski.wasm ../wasm/release.wasm

            echo ""
            echo "=== WASM Module Structure (debug) ==="
            ${pkgs.wabt}/bin/wasm-objdump -h ../wasm/debug.wasm
            echo ""
            echo "=== WASM Module Structure (release) ==="
            ${pkgs.wabt}/bin/wasm-objdump -h ../wasm/release.wasm
            echo ""

            cd ..
            echo "Embedding WASM..."
            ${deno}/bin/deno run -A scripts/embed-wasm.ts
          '';

          installPhase = ''
            mkdir -p $out
            cp -r . $out/
          '';

          doCheck = false;
        };

        # Development Shell
        devShell = pkgs.mkShell {
          buildInputs = [
            rustToolchain
            deno
            pkgs.jq
            pkgs.wabt
            verifyVersion
            generateCargoToml
            generateVersionTs
          ];

        };

      in
      {
        packages.default = typedSki;
        devShells.default = devShell;

        apps = {
           verify-version = { type = "app"; program = "${verifyVersion}/bin/verify-version"; };
           generate-cargo = { type = "app"; program = "${generateCargoToml}/bin/generate-cargo-toml"; };
           generate-version-ts = { type = "app"; program = "${generateVersionTs}/bin/generate-version-ts"; };
           test = {
            type = "app";
            program = toString (pkgs.writeShellScript "run-tests" ''
              if [ ! -f deno.jsonc ]; then echo "Error: Run from project root"; exit 1; fi
              export PATH="${deno}/bin:$PATH"
              ${deno}/bin/deno test --allow-read --allow-write --allow-run --allow-env --unstable-worker-options --parallel test/
            '');
           };
           fmt = {
            type = "app";
            program = toString (pkgs.writeShellScript "deno-fmt" ''
              ${deno}/bin/deno fmt "$@"
            '');
           };
           lint = {
            type = "app";
            program = toString (pkgs.writeShellScript "deno-lint" ''
              ${deno}/bin/deno lint "$@"
            '');
           };
           publish = {
            type = "app";
            program = toString (pkgs.writeShellScript "deno-publish" ''
              ${deno}/bin/deno publish "$@"
            '');
           };
           test-rust = {
            type = "app";
            program = toString (pkgs.writeShellScript "test-rust" ''
              cd rust
              export PATH="${rustToolchain}/bin:$PATH"
              export CARGO="${rustToolchain}/bin/cargo"
              export RUSTC="${rustToolchain}/bin/rustc"
              ${rustToolchain}/bin/cargo test --lib -- --test-threads=1 "$@"
            '');
           };
        };
      }
    );
}
