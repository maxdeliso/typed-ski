import { assertEquals } from "std/assert";

import { getReleaseWasmCandidateUrlsForTest } from "../../lib/evaluator/arenaWasmLoader.ts";

Deno.test("arenaWasmLoader - source layout fallback ordering", () => {
  const urls = getReleaseWasmCandidateUrlsForTest({
    importMetaUrl:
      "file:///home/max/src/typed-ski/lib/evaluator/arenaWasmLoader.ts",
    version: "0.14.10",
  });

  assertEquals(urls, [
    "file:///home/max/src/typed-ski/wasm/release.wasm",
    "https://jsr.io/@maxdeliso/typed-ski/0.14.10/wasm/release.wasm",
  ]);
});

Deno.test("arenaWasmLoader - bundled dist layout fallback ordering", () => {
  const urls = getReleaseWasmCandidateUrlsForTest({
    importMetaUrl: "file:///home/max/src/typed-ski/dist/tripc.js",
    version: "0.14.10",
  });

  assertEquals(urls, [
    "file:///home/max/src/typed-ski/wasm/release.wasm",
    "https://jsr.io/@maxdeliso/typed-ski/0.14.10/wasm/release.wasm",
  ]);
});

Deno.test("arenaWasmLoader - compiled binary path is preferred over module path", () => {
  const urls = getReleaseWasmCandidateUrlsForTest({
    importMetaUrl:
      "file:///tmp/deno-compile-tripc/lib/evaluator/arenaWasmLoader.ts",
    version: "0.14.10",
    execPath: "/home/max/src/typed-ski/dist/tripc",
  });

  assertEquals(urls, [
    "file:///home/max/src/typed-ski/wasm/release.wasm",
    "file:///tmp/deno-compile-tripc/wasm/release.wasm",
    "https://jsr.io/@maxdeliso/typed-ski/0.14.10/wasm/release.wasm",
  ]);
});

Deno.test("arenaWasmLoader - env path override is first local candidate", () => {
  const urls = getReleaseWasmCandidateUrlsForTest({
    importMetaUrl:
      "file:///home/max/src/typed-ski/lib/evaluator/arenaWasmLoader.ts",
    version: "0.14.10",
    envWasmPath: "file:///opt/typed-ski/release.wasm",
  });

  assertEquals(urls, [
    "file:///opt/typed-ski/release.wasm",
    "file:///home/max/src/typed-ski/wasm/release.wasm",
    "https://jsr.io/@maxdeliso/typed-ski/0.14.10/wasm/release.wasm",
  ]);
});

Deno.test("arenaWasmLoader - env URL fallback precedes version fallback", () => {
  const urls = getReleaseWasmCandidateUrlsForTest({
    importMetaUrl:
      "file:///home/max/src/typed-ski/lib/evaluator/arenaWasmLoader.ts",
    version: "0.14.10",
    envWasmUrl: "https://cdn.example.com/typed-ski/release.wasm",
  });

  assertEquals(urls, [
    "file:///home/max/src/typed-ski/wasm/release.wasm",
    "https://cdn.example.com/typed-ski/release.wasm",
    "https://jsr.io/@maxdeliso/typed-ski/0.14.10/wasm/release.wasm",
  ]);
});

Deno.test("arenaWasmLoader - non-semver version disables automatic JSR fallback", () => {
  const urls = getReleaseWasmCandidateUrlsForTest({
    importMetaUrl:
      "file:///home/max/src/typed-ski/lib/evaluator/arenaWasmLoader.ts",
    version: "development",
  });

  assertEquals(urls, [
    "file:///home/max/src/typed-ski/wasm/release.wasm",
  ]);
});
