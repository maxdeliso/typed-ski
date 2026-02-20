{
  description = "typed-ski: SKI calculus implementation with C11 WASM core";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    nixpkgs-deno.url = "github:NixOS/nixpkgs/nixos-unstable-small";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs =
    { nixpkgs
    , nixpkgs-deno
    , flake-utils
    , ...
    }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = import nixpkgs { inherit system; };
        denoPkgs = import nixpkgs-deno { inherit system; };

        deno = denoPkgs.deno;
        llvm = pkgs.llvmPackages_18;
        wasmIncludeDir = "${llvm.clang-unwrapped.lib}/lib/clang/18/include";

        denoJson = builtins.fromJSON (builtins.readFile ./deno.jsonc);
        version = denoJson.version;

        verifyVersion = pkgs.writeShellScriptBin "verify-version" ''
          if ! ${pkgs.jq}/bin/jq -e '.version' deno.jsonc >/dev/null 2>&1; then
            echo "Error: version field is required in deno.jsonc"
            exit 1
          fi
          echo "Version in deno.jsonc: $(${pkgs.jq}/bin/jq -r '.version' deno.jsonc)"
        '';

        generateVersionTs = pkgs.writeShellScriptBin "generate-version-ts" ''
          mkdir -p lib/shared
          cat > lib/shared/version.generated.ts << EOF_VERSION
          export const VERSION = "${version}";
          EOF_VERSION
          echo "Generated lib/shared/version.generated.ts"
        '';

        generateArenaHeaderC = pkgs.writeShellScriptBin "generate-arena-header-c" ''
          ${deno}/bin/deno run -A scripts/generate-arena-header-c.ts
        '';

        typedSki = pkgs.stdenv.mkDerivation {
          name = "typed-ski";
          inherit version;

          src = ./.;

          nativeBuildInputs = [
            llvm.clang
            llvm.clang-unwrapped
            llvm.lld
            llvm.llvm
            deno
            pkgs.jq
            pkgs.wabt
            verifyVersion
            generateVersionTs
            generateArenaHeaderC
          ];

          buildPhase = ''
            export HOME="$PWD/.nix-home"
            export DENO_DIR="$PWD/.deno-cache"
            mkdir -p "$HOME" "$DENO_DIR"

            verify-version
            generate-version-ts
            generate-arena-header-c

            mkdir -p wasm
            ${llvm.clang-unwrapped}/bin/clang --target=wasm32 -O3 -nostdlib \
                  -Wl,--no-entry -Wl,--export-all -Wl,--import-memory -Wl,--shared-memory \
                  -Wl,--max-memory=4294967296 \
                  -matomics -mbulk-memory -mmutable-globals \
                  -isystem "${wasmIncludeDir}" \
                  -o wasm/release.wasm c/arena.c

            echo ""
            echo "=== WASM Module Structure (release) ==="
            ${pkgs.wabt}/bin/wasm-objdump -h wasm/release.wasm
            echo ""
          '';

          installPhase = ''
            mkdir -p $out
            cp -r . $out/
          '';

          doCheck = false;
        };

        devShell = pkgs.mkShell {
          buildInputs = [
            llvm.clang
            llvm.clang-unwrapped
            llvm.lld
            llvm.llvm
            pkgs.nixpkgs-fmt
            deno
            generateArenaHeaderC
          ];

          shellHook = ''
            export CC="${llvm.clang}/bin/clang"
            export CXX="${llvm.clang}/bin/clang++"
            export WASM_CC="${llvm.clang-unwrapped}/bin/clang"
            export WASM_LD="${llvm.lld}/bin/wasm-ld"
            export WASM_RESOURCE_DIR="${llvm.clang-unwrapped.lib}/lib/clang/18"
          '';
        };
      in
      {
        packages.default = typedSki;
        devShells.default = devShell;

        apps = {
          verify-version = {
            type = "app";
            program = "${verifyVersion}/bin/verify-version";
          };
          generate-version-ts = {
            type = "app";
            program = "${generateVersionTs}/bin/generate-version-ts";
          };
          generate-arena-header = {
            type = "app";
            program = "${generateArenaHeaderC}/bin/generate-arena-header-c";
          };
          test = {
            type = "app";
            program = toString (pkgs.writeShellScript "run-tests" ''
              if [ ! -f deno.jsonc ]; then echo "Error: Run from project root"; exit 1; fi
              export PATH="${deno}/bin:$PATH"
              ${deno}/bin/deno test --allow-read --allow-write --allow-run --allow-env --parallel test/
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
        };
      }
    );
}
