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
let cachedReleaseLoadInfo: ReleaseWasmLoadInfo | null = null;

interface ReleaseWasmCandidateInputs {
  importMetaUrl: string;
  version: string;
  envWasmPath?: string;
  envWasmUrl?: string;
  execPath?: string;
}

type ReleaseWasmCandidateKind =
  | "env-path"
  | "exec-path"
  | "module-path"
  | "env-url"
  | "version-url";

interface ReleaseWasmCandidate {
  kind: ReleaseWasmCandidateKind;
  url: URL;
}

export interface ReleaseWasmLoadInfo {
  kind: ReleaseWasmCandidateKind;
  url: string;
  via: "readFile" | "readFileSync" | "fetch";
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

function getReleaseWasmCandidates(): ReleaseWasmCandidate[] {
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

function buildReleaseWasmCandidates(
  inputs: ReleaseWasmCandidateInputs,
): ReleaseWasmCandidate[] {
  const localCandidates: ReleaseWasmCandidate[] = [];
  const remoteCandidates: ReleaseWasmCandidate[] = [];
  const add = (candidate: ReleaseWasmCandidate | null) => {
    if (!candidate) return;
    const list =
      candidate.url.protocol === "http:" || candidate.url.protocol === "https:"
        ? remoteCandidates
        : localCandidates;
    if (list.some((item) => item.url.href === candidate.url.href)) return;
    list.push(candidate);
  };

  const envPathCandidate = getWasmUrlFromEnv(
    inputs.envWasmPath,
    inputs.importMetaUrl,
  );
  const envUrlCandidate = getWasmUrlNetworkFallbackFromEnv(inputs.envWasmUrl);

  if (envPathCandidate) {
    add(envPathCandidate);
  }

  if (envUrlCandidate) {
    add(envUrlCandidate);
  }

  // If ANY override is provided (path OR URL), skip the standard local and exec candidates.
  if (envPathCandidate || envUrlCandidate) {
    // We still allow the version-pinned remote fallback as a last resort.
    add(getWasmUrlNetworkFallbackFromVersion(inputs.version));
    return [...localCandidates, ...remoteCandidates];
  }

  // Fall back to standard locations only if no environment overrides are set.
  add(getWasmUrlFromExecPath(inputs.execPath));
  for (const candidate of getWasmUrlFromModulePath(inputs.importMetaUrl)) {
    add(candidate);
  }
  add(getWasmUrlNetworkFallbackFromVersion(inputs.version));
  return [...localCandidates, ...remoteCandidates];
}

function getWasmUrlFromEnv(
  env: string | undefined,
  importMetaUrl: string,
): ReleaseWasmCandidate | null {
  if (!env) return null;
  if (/^(?:[a-zA-Z]:[\\/]|[\\/])/.test(env)) {
    try {
      const normalizedPath = env.replace(/\\/g, "/");
      const urlStr = normalizedPath.startsWith("/")
        ? `file://${normalizedPath}`
        : `file:///${normalizedPath}`;
      return { kind: "env-path", url: new URL(urlStr) };
    } catch {
      return null;
    }
  }
  try {
    return { kind: "env-path", url: new URL(env) };
  } catch {
    // If it's not a valid URL, it might be a relative or absolute path.
    // Try resolving it against importMetaUrl first.
    try {
      const url = new URL(env, importMetaUrl);
      return { kind: "env-path", url };
    } catch {
      return null;
    }
  }
}

function getWasmUrlNetworkFallbackFromEnv(
  env: string | undefined,
): ReleaseWasmCandidate | null {
  if (!env) return null;
  try {
    const url = new URL(env);
    if (url.protocol === "http:" || url.protocol === "https:") {
      return { kind: "env-url", url };
    }
    return null;
  } catch {
    return null;
  }
}

function getWasmUrlNetworkFallbackFromVersion(
  version: string,
): ReleaseWasmCandidate | null {
  // VERSION is generated from deno.jsonc during build.
  if (!/^\d+\.\d+\.\d+$/.test(version)) return null;
  return {
    kind: "version-url",
    url: new URL(
      `https://jsr.io/@maxdeliso/typed-ski/${version}/wasm/release.wasm`,
    ),
  };
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

function getWasmUrlFromExecPath(
  execPath: string | undefined,
): ReleaseWasmCandidate | null {
  if (!execPath) return null;
  try {
    const exec = execPath;
    // Ignore normal `deno run` runtime; this fallback is for `deno compile`.
    if (/(^|\/)deno(\.exe)?$/.test(exec)) return null;
    return {
      kind: "exec-path",
      url: new URL("../wasm/release.wasm", `file://${exec}`),
    };
  } catch {
    return null;
  }
}

function getWasmUrlFromModulePath(
  importMetaUrl: string,
): ReleaseWasmCandidate[] {
  const moduleUrl = new URL(importMetaUrl);
  const candidates: ReleaseWasmCandidate[] = [];

  if (
    moduleUrl.protocol === "file:" &&
    /\/dist\/[^/]+(\.min)?\.js$/.test(moduleUrl.pathname)
  ) {
    candidates.push({
      kind: "module-path",
      url: new URL("../wasm/release.wasm", moduleUrl),
    });
  } else {
    candidates.push({
      kind: "module-path",
      url: new URL("../../wasm/release.wasm", moduleUrl),
    });
  }

  // Also look for the bazel-built version in the staged location if it exists
  // but use module-path kind since it is just a file path.
  return candidates;
}

async function tryLoadReleaseWasmFromCandidates(): Promise<ArrayBuffer | null> {
  const deno = getDenoGlobal();
  const candidates = getReleaseWasmCandidates();

  if (deno) {
    for (const candidate of candidates) {
      if (candidate.url.protocol !== "file:") continue;
      try {
        const bytes = await deno.readFile(candidate.url);
        cachedReleaseLoadInfo = {
          kind: candidate.kind,
          url: candidate.url.href,
          via: "readFile",
        };
        return uint8ArrayToArrayBuffer(bytes);
      } catch {
        // Continue to next candidate.
      }
    }
  }

  for (const candidate of candidates) {
    try {
      const response = await fetch(candidate.url);
      if (!response.ok) continue;
      cachedReleaseLoadInfo = {
        kind: candidate.kind,
        url: candidate.url.href,
        via: "fetch",
      };
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
    if (candidate.url.protocol !== "file:") continue;
    try {
      const bytes = deno.readFileSync(candidate.url);
      cachedReleaseLoadInfo = {
        kind: candidate.kind,
        url: candidate.url.href,
        via: "readFileSync",
      };
      return uint8ArrayToArrayBuffer(bytes);
    } catch {
      // Continue to next candidate.
    }
  }

  return null;
}

/** @internal */
export function resetReleaseWasmCache(): void {
  cachedReleaseBytes = null;
  releaseBytesPromise = null;
  cachedReleaseLoadInfo = null;
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
      if (cachedReleaseLoadInfo?.kind === "version-url") {
        console.warn(
          `Using published JSR wasm fallback: ${cachedReleaseLoadInfo.url}`,
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

/** @internal */
export function getLastReleaseWasmLoadInfo(): ReleaseWasmLoadInfo | null {
  return cachedReleaseLoadInfo;
}

/** @internal */
export function formatReleaseWasmLoadInfo(
  info: ReleaseWasmLoadInfo | null,
): string {
  if (!info) return "unknown";
  switch (info.kind) {
    case "env-path":
      return `env path (${info.via})`;
    case "exec-path":
      return `compiled path (${info.via})`;
    case "module-path":
      return `local path (${info.via})`;
    case "env-url":
      return `env URL fallback (${info.via})`;
    case "version-url":
      return `published JSR fallback (${info.via})`;
  }
}
