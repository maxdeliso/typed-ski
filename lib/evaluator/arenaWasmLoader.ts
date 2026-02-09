/**
 * Runtime WASM loader for arena evaluator.
 *
 * Load order:
 * 1. `TYPED_SKI_WASM_PATH` override (file path or URL).
 * 2. Path derived from compiled binary location (`../wasm/release.wasm`).
 * 3. Path derived from module location:
 *    - source modules: `../../wasm/release.wasm`
 *    - bundled dist modules: `../wasm/release.wasm`
 * 4. `TYPED_SKI_WASM_URL` network fallback.
 * 5. Version-pinned JSR fallback derived from `deno.jsonc` version.
 */

import { VERSION } from "../shared/version.generated.ts";

let cachedReleaseBytes: Uint8Array | null = null;
let releaseBytesPromise: Promise<ArrayBuffer> | null = null;

interface ReleaseWasmCandidateInputs {
  importMetaUrl: string;
  version: string;
  envWasmPath?: string;
  envWasmUrl?: string;
  execPath?: string;
}

function uint8ArrayToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer as ArrayBuffer;
}

function getDenoGlobal():
  | {
    readFile(path: string | URL): Promise<Uint8Array>;
    readFileSync(path: string | URL): Uint8Array;
    execPath?: () => string;
  }
  | null {
  const deno = (globalThis as typeof globalThis & { Deno?: unknown }).Deno;
  if (!deno || typeof deno !== "object") return null;
  const maybe = deno as {
    readFile?: unknown;
    readFileSync?: unknown;
    execPath?: unknown;
  };
  if (
    typeof maybe.readFile !== "function" ||
    typeof maybe.readFileSync !== "function"
  ) {
    return null;
  }
  return {
    readFile: maybe.readFile as (path: string | URL) => Promise<Uint8Array>,
    readFileSync: maybe.readFileSync as (path: string | URL) => Uint8Array,
    execPath: typeof maybe.execPath === "function"
      ? (maybe.execPath as () => string)
      : undefined,
  };
}

function getReleaseWasmCandidates(): URL[] {
  return buildReleaseWasmCandidates({
    importMetaUrl: import.meta.url,
    version: VERSION,
    envWasmPath: getDenoEnvVar("TYPED_SKI_WASM_PATH"),
    envWasmUrl: getDenoEnvVar("TYPED_SKI_WASM_URL"),
    execPath: getExecPath(),
  });
}

function getExecPath(): string | undefined {
  try {
    return getDenoGlobal()?.execPath?.();
  } catch {
    return undefined;
  }
}

function buildReleaseWasmCandidates(inputs: ReleaseWasmCandidateInputs): URL[] {
  const localCandidates: URL[] = [];
  const remoteCandidates: URL[] = [];
  const add = (url: URL | null) => {
    if (!url) return;
    const list = url.protocol === "http:" || url.protocol === "https:"
      ? remoteCandidates
      : localCandidates;
    if (list.some((candidate) => candidate.href === url.href)) return;
    list.push(url);
  };

  add(getWasmUrlFromEnv(inputs.envWasmPath, inputs.importMetaUrl));
  add(getWasmUrlFromExecPath(inputs.execPath));
  add(getWasmUrlFromModulePath(inputs.importMetaUrl));
  add(getWasmUrlNetworkFallbackFromEnv(inputs.envWasmUrl));
  add(getWasmUrlNetworkFallbackFromVersion(inputs.version));
  return [...localCandidates, ...remoteCandidates];
}

export function getReleaseWasmCandidateUrlsForTest(
  inputs: ReleaseWasmCandidateInputs,
): string[] {
  return buildReleaseWasmCandidates(inputs).map((url) => url.href);
}

function getWasmUrlFromEnv(
  env: string | undefined,
  importMetaUrl: string,
): URL | null {
  if (!env) return null;
  try {
    return new URL(env);
  } catch {
    try {
      return new URL(env, importMetaUrl);
    } catch {
      return null;
    }
  }
}

function getWasmUrlNetworkFallbackFromEnv(env: string | undefined): URL | null {
  if (!env) return null;
  try {
    const url = new URL(env);
    if (url.protocol === "http:" || url.protocol === "https:") {
      return url;
    }
    return null;
  } catch {
    return null;
  }
}

function getWasmUrlNetworkFallbackFromVersion(version: string): URL | null {
  // VERSION is generated from deno.jsonc during build.
  if (!/^\d+\.\d+\.\d+$/.test(version)) return null;
  return new URL(
    `https://jsr.io/@maxdeliso/typed-ski/${version}/wasm/release.wasm`,
  );
}

function getDenoEnvVar(name: string): string | undefined {
  try {
    return (globalThis as typeof globalThis & {
      Deno?: { env?: { get(name: string): string | undefined } };
    }).Deno?.env?.get?.(name);
  } catch {
    return undefined;
  }
}

function getWasmUrlFromExecPath(execPath: string | undefined): URL | null {
  if (!execPath) return null;
  try {
    const exec = execPath;
    // Ignore normal `deno run` runtime; this fallback is for `deno compile`.
    if (/(^|\/)deno(\.exe)?$/.test(exec)) return null;
    return new URL("../wasm/release.wasm", `file://${exec}`);
  } catch {
    return null;
  }
}

function getWasmUrlFromModulePath(importMetaUrl: string): URL {
  const moduleUrl = new URL(importMetaUrl);
  if (
    moduleUrl.protocol === "file:" &&
    /\/dist\/[^/]+(\.min)?\.js$/.test(moduleUrl.pathname)
  ) {
    return new URL("../wasm/release.wasm", moduleUrl);
  }
  return new URL("../../wasm/release.wasm", moduleUrl);
}

async function tryLoadReleaseWasmFromCandidates(): Promise<ArrayBuffer | null> {
  const deno = getDenoGlobal();
  const candidates = getReleaseWasmCandidates();

  if (deno) {
    for (const candidate of candidates) {
      if (candidate.protocol !== "file:") continue;
      try {
        const bytes = await deno.readFile(candidate);
        return uint8ArrayToArrayBuffer(bytes);
      } catch {
        // Continue to next candidate.
      }
    }
  }

  for (const candidate of candidates) {
    try {
      const response = await fetch(candidate);
      if (!response.ok) continue;
      return await response.arrayBuffer();
    } catch {
      // Continue to next candidate.
    }
  }

  return null;
}

function tryLoadReleaseWasmFromCandidatesSync(): ArrayBuffer | null {
  const deno = getDenoGlobal();
  if (!deno) return null;

  for (const candidate of getReleaseWasmCandidates()) {
    if (candidate.protocol !== "file:") continue;
    try {
      const bytes = deno.readFileSync(candidate);
      return uint8ArrayToArrayBuffer(bytes);
    } catch {
      // Continue to next candidate.
    }
  }

  return null;
}

export async function getReleaseWasmBytes(): Promise<ArrayBuffer> {
  if (cachedReleaseBytes) return uint8ArrayToArrayBuffer(cachedReleaseBytes);
  if (!releaseBytesPromise) {
    releaseBytesPromise = (async () => {
      const bytes = await tryLoadReleaseWasmFromCandidates();
      if (!bytes) {
        throw new Error(
          "Unable to load wasm/release.wasm. Set TYPED_SKI_WASM_PATH or TYPED_SKI_WASM_URL to override.",
        );
      }
      cachedReleaseBytes = new Uint8Array(bytes);
      return bytes;
    })();
  }
  return await releaseBytesPromise;
}

export function getReleaseWasmBytesSync(): ArrayBuffer {
  if (cachedReleaseBytes) return uint8ArrayToArrayBuffer(cachedReleaseBytes);

  const direct = tryLoadReleaseWasmFromCandidatesSync();
  if (direct) {
    cachedReleaseBytes = new Uint8Array(direct);
    return direct;
  }

  throw new Error(
    "Unable to load wasm/release.wasm synchronously. Set TYPED_SKI_WASM_PATH for synchronous loading.",
  );
}
