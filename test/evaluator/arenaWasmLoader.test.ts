import { test, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import { pathToFileURL, fileURLToPath } from "node:url";

type LoaderModule = typeof import("../../lib/evaluator/arenaWasmLoader.ts");
import {
  formatReleaseWasmLoadInfo,
  getLastReleaseWasmLoadInfo,
  getReleaseWasmBytes,
  resetReleaseWasmCache,
} from "../../lib/evaluator/arenaWasmLoader.ts";
import { VERSION } from "../../lib/shared/version.generated.ts";

const isWindows = process.platform === "win32";

function toFileUrl(p: string) {
  // If p is absolute and starts with /, prepend C: if on Windows to make it a valid file URL
  if (isWindows && p.startsWith("/") && !p.startsWith("//")) {
    p = "C:" + p;
  }
  return pathToFileURL(p).href;
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const jsrVersionedWasmUrlPattern = new RegExp(
  `^https:\\/\\/jsr\\.io\\/@maxdeliso\\/typed-ski\\/${escapeRegExp(
    VERSION,
  )}\\/wasm\\/release\\.wasm$`,
);

const moduleWasmUrl = new URL(
  "../../wasm/release.wasm",
  new URL("../../lib/evaluator/arenaWasmLoader.ts", import.meta.url),
).href;

const compiledWasmUrl = toFileUrl("/tmp/wasm/release.wasm");
const execWasmUrl = toFileUrl("/usr/local/wasm/release.wasm");

async function importFreshLoaderModule(): Promise<LoaderModule> {
  return await import(
    `../../lib/evaluator/arenaWasmLoader.ts?case=${crypto.randomUUID()}`
  );
}

function bytes(values: number[]): ArrayBuffer {
  return new Uint8Array(values).buffer;
}

function restoreGlobal(name: "fetch", previous: unknown): void {
  const globals = globalThis as Record<string, unknown>;
  if (previous === undefined) {
    delete globals[name];
    return;
  }
  globals[name] = previous;
}

interface NodeOverrides {
  readFile?: (path: string | URL) => Promise<Uint8Array | Buffer>;
  readFileSync?: (path: string | URL) => Uint8Array | Buffer;
  env?: Record<string, string | undefined>;
  execPath?: string;
}

function patchNode(overrides: NodeOverrides) {
  const previousEnv = { ...process.env };
  const originalExecPath = process.execPath;

  if (overrides.env) {
    for (const [key, value] of Object.entries(overrides.env)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }

  if (overrides.execPath) {
    Object.defineProperty(process, "execPath", {
      value: overrides.execPath,
      configurable: true,
      enumerable: true,
      writable: true,
    });
  }

  const readFileSyncMock = overrides.readFileSync
    ? mock.method(fs, "readFileSync", overrides.readFileSync)
    : null;
  const readFileMock = overrides.readFile
    ? mock.method(fsPromises, "readFile", overrides.readFile)
    : null;

  return () => {
    // Restore env
    for (const key of Object.keys(process.env)) {
      if (!(key in previousEnv)) delete process.env[key];
    }
    Object.assign(process.env, previousEnv);

    Object.defineProperty(process, "execPath", {
      value: originalExecPath,
      configurable: true,
      enumerable: true,
      writable: true,
    });
    (readFileSyncMock as any)?.mock?.restore();
    (readFileMock as any)?.mock?.restore();
  };
}

test("arenaWasmLoader - async loading prefers local file in Node and caches bytes", async () => {
  resetReleaseWasmCache();
  const globals = globalThis as Record<string, unknown>;
  const previousFetch = globals["fetch"];

  let readFileCalls = 0;
  const restoreNode = patchNode({
    env: {
      TYPED_SKI_WASM_PATH: undefined,
      TYPED_SKI_WASM_URL: undefined,
    },
    execPath: isWindows
      ? "C:\\usr\\local\\bin\\typed-ski"
      : "/usr/local/bin/typed-ski",
    readFile: async (path) => {
      readFileCalls += 1;
      return Buffer.from([1, 2, 3]);
    },
    readFileSync: (path) => Buffer.from([7, 8, 9]),
  });
  globals["fetch"] = () => {
    throw new Error("fetch should not be called");
  };

  try {
    const loader = await importFreshLoaderModule();
    const first = await loader.getReleaseWasmBytes();
    const second = await loader.getReleaseWasmBytes();
    assert.deepStrictEqual(Array.from(new Uint8Array(first)), [1, 2, 3]);
    assert.deepStrictEqual(Array.from(new Uint8Array(second)), [1, 2, 3]);
    assert.deepStrictEqual(readFileCalls, 1);
    assert.deepStrictEqual(loader.getLastReleaseWasmLoadInfo(), {
      kind: "exec-path",
      url: execWasmUrl,
      via: "readFile",
    });
  } finally {
    restoreNode();
    restoreGlobal("fetch", previousFetch);
  }
});

test("arenaWasmLoader - Windows absolute env paths normalize to file URLs", async () => {
  resetReleaseWasmCache();
  const globals = globalThis as Record<string, unknown>;
  const previousFetch = globals["fetch"];
  const localAttempts: string[] = [];

  const restoreNode = patchNode({
    env: {
      TYPED_SKI_WASM_PATH: "C:\\temp\\release.wasm",
      TYPED_SKI_WASM_URL: undefined,
    },
    execPath: isWindows ? "C:\\usr\\bin\\node" : "/usr/bin/node",
    readFile: async (path) => {
      // Normalize path back to file URL for comparison if it's a string
      const url =
        typeof path === "string" ? pathToFileURL(path).href : path.href;
      localAttempts.push(url);
      return Buffer.from([9, 9]);
    },
    readFileSync: () => {
      throw new Error("unused");
    },
  });
  globals["fetch"] = () => {
    throw new Error("fetch should not be called");
  };

  try {
    const loader = await importFreshLoaderModule();
    const loaded = await loader.getReleaseWasmBytes();
    assert.deepStrictEqual(Array.from(new Uint8Array(loaded)), [9, 9]);
    assert.deepStrictEqual(localAttempts, ["file:///C:/temp/release.wasm"]);
    assert.deepStrictEqual(loader.getLastReleaseWasmLoadInfo(), {
      kind: "env-path",
      url: "file:///C:/temp/release.wasm",
      via: "readFile",
    });
  } finally {
    restoreNode();
    restoreGlobal("fetch", previousFetch);
  }
});

test("arenaWasmLoader - compiled exec path falls back to module path", async () => {
  resetReleaseWasmCache();
  const globals = globalThis as Record<string, unknown>;
  const previousFetch = globals["fetch"];
  const localAttempts: string[] = [];

  const restoreNode = patchNode({
    env: {
      TYPED_SKI_WASM_PATH: undefined,
      TYPED_SKI_WASM_URL: undefined,
    },
    execPath: isWindows
      ? "C:\\tmp\\node-compile-tripc\\tripc"
      : "/tmp/node-compile-tripc/tripc",
    readFile: async (path) => {
      const url =
        typeof path === "string" ? pathToFileURL(path).href : path.href;
      localAttempts.push(url);
      if (url === compiledWasmUrl) {
        throw new Error("missing compiled wasm");
      }
      if (url === moduleWasmUrl) {
        return Buffer.from([4, 4]);
      }
      throw new Error(`unexpected candidate: ${url}`);
    },
    readFileSync: () => {
      throw new Error("unused");
    },
  });
  globals["fetch"] = () => {
    throw new Error("fetch should not be called");
  };

  try {
    const loader = await importFreshLoaderModule();
    const loaded = await loader.getReleaseWasmBytes();
    assert.deepStrictEqual(Array.from(new Uint8Array(loaded)), [4, 4]);
    assert.deepStrictEqual(localAttempts.slice(0, 2), [
      compiledWasmUrl,
      moduleWasmUrl,
    ]);
    assert.deepStrictEqual(loader.getLastReleaseWasmLoadInfo(), {
      kind: "module-path",
      url: moduleWasmUrl,
      via: "readFile",
    });
  } finally {
    restoreNode();
    restoreGlobal("fetch", previousFetch);
  }
});

test("arenaWasmLoader - invalid env path and exec path are ignored", async () => {
  resetReleaseWasmCache();
  const globals = globalThis as Record<string, unknown>;
  const previousFetch = globals["fetch"];
  const localAttempts: string[] = [];

  const restoreNode = patchNode({
    env: {
      TYPED_SKI_WASM_PATH: "relative/path/without/slashes",
      TYPED_SKI_WASM_URL: undefined,
    },
    execPath: isWindows ? "C:\\usr\\bin\\node" : "/usr/bin/node", // should be ignored
    readFile: async (path) => {
      const url =
        typeof path === "string" ? pathToFileURL(path).href : path.href;
      localAttempts.push(url);
      throw new Error("not found");
    },
    readFileSync: () => {
      throw new Error("not found");
    },
  });

  globals["fetch"] = () =>
    Promise.resolve({
      ok: true,
      arrayBuffer: () => Promise.resolve(bytes([1])),
    } as Response);

  try {
    const loader = await importFreshLoaderModule();
    await loader.getReleaseWasmBytes();

    const expectedUrl = new URL(
      "relative/path/without/slashes",
      new URL("../../lib/evaluator/arenaWasmLoader.ts", import.meta.url),
    ).href;

    assert.deepStrictEqual(localAttempts, [expectedUrl]);
  } finally {
    restoreNode();
    restoreGlobal("fetch", previousFetch);
  }
});

test("arenaWasmLoader - node runtime exec path and file env URL are ignored as network fallbacks", async () => {
  resetReleaseWasmCache();
  const globals = globalThis as Record<string, unknown>;
  const previousFetch = globals["fetch"];
  const localAttempts: string[] = [];
  const remoteAttempts: string[] = [];

  const restoreNode = patchNode({
    env: {
      TYPED_SKI_WASM_PATH: undefined,
      TYPED_SKI_WASM_URL: "https://cdn.example.com/release.wasm",
    },
    execPath: isWindows ? "C:\\usr\\bin\\node" : "/usr/bin/node",
    readFile: async () => {
      // Standard local paths are skipped when TYPED_SKI_WASM_URL is provided.
      throw new Error("not found");
    },
    readFileSync: () => {
      throw new Error("not found");
    },
  });

  globals["fetch"] = ((url: string | URL) => {
    remoteAttempts.push(url.toString());
    // Fail the first one to see it attempt the versioned fallback.
    if (url.toString() === "https://cdn.example.com/release.wasm") {
      return Promise.resolve({ ok: false } as Response);
    }
    return Promise.resolve({
      ok: true,
      arrayBuffer: () => Promise.resolve(bytes([1])),
    } as Response);
  }) as typeof fetch;

  try {
    const loader = await importFreshLoaderModule();
    await loader.getReleaseWasmBytes();

    assert.deepStrictEqual(localAttempts, []);
    assert.deepStrictEqual(
      remoteAttempts[0],
      "https://cdn.example.com/release.wasm",
    );
    assert.match(remoteAttempts[1]!, jsrVersionedWasmUrlPattern);
  } finally {
    restoreNode();
    restoreGlobal("fetch", previousFetch);
  }
});

test("arenaWasmLoader - env URL success bypasses local candidates", async () => {
  resetReleaseWasmCache();
  const globals = globalThis as Record<string, unknown>;
  const previousFetch = globals["fetch"];
  const localAttempts: string[] = [];
  const remoteAttempts: string[] = [];

  const restoreNode = patchNode({
    env: {
      TYPED_SKI_WASM_PATH: undefined,
      TYPED_SKI_WASM_URL: "https://cdn.example.com/success.wasm",
    },
    execPath: isWindows
      ? "C:\\tmp\\node-compile-tripc\\tripc"
      : "/tmp/node-compile-tripc/tripc",
    readFile: async (path) => {
      const url =
        typeof path === "string" ? pathToFileURL(path).href : path.href;
      localAttempts.push(url);
      throw new Error("local file candidates should be skipped");
    },
    readFileSync: () => {
      throw new Error("unused");
    },
  });

  globals["fetch"] = ((url: string | URL) => {
    remoteAttempts.push(url.toString());
    return Promise.resolve({
      ok: true,
      arrayBuffer: () => Promise.resolve(bytes([7, 7, 7])),
    } as Response);
  }) as typeof fetch;

  try {
    const loader = await importFreshLoaderModule();
    const loaded = await loader.getReleaseWasmBytes();
    assert.deepStrictEqual(Array.from(new Uint8Array(loaded)), [7, 7, 7]);
    assert.deepStrictEqual(localAttempts, []);
    assert.deepStrictEqual(remoteAttempts, [
      "https://cdn.example.com/success.wasm",
    ]);
    assert.deepStrictEqual(loader.getLastReleaseWasmLoadInfo(), {
      kind: "env-url",
      url: "https://cdn.example.com/success.wasm",
      via: "fetch",
    });
  } finally {
    restoreNode();
    restoreGlobal("fetch", previousFetch);
  }
});

test("arenaWasmLoader - async loading throws when all candidates fail", async () => {
  resetReleaseWasmCache();
  const globals = globalThis as Record<string, unknown>;
  const previousFetch = globals["fetch"];

  const restoreNode = patchNode({
    env: {
      TYPED_SKI_WASM_PATH: undefined,
      TYPED_SKI_WASM_URL: undefined,
    },
    execPath: isWindows ? "C:\\usr\\bin\\node" : "/usr/bin/node",
    readFile: async () => {
      throw new Error("not found");
    },
    readFileSync: () => {
      throw new Error("not found");
    },
  });

  globals["fetch"] = (() =>
    Promise.resolve({ ok: false } as Response)) as typeof fetch;

  try {
    const loader = await importFreshLoaderModule();
    await assert.rejects(() => loader.getReleaseWasmBytes(), {
      message:
        "Unable to load wasm/release.wasm. Set TYPED_SKI_WASM_PATH or TYPED_SKI_WASM_URL to override.",
    });
  } finally {
    restoreNode();
    restoreGlobal("fetch", previousFetch);
  }
});

test("arenaWasmLoader - async loading continues after fetch error", async () => {
  resetReleaseWasmCache();
  const globals = globalThis as Record<string, unknown>;
  const previousFetch = globals["fetch"];
  const remoteAttempts: string[] = [];

  const restoreNode = patchNode({
    env: {
      TYPED_SKI_WASM_PATH: undefined,
      TYPED_SKI_WASM_URL: "https://cdn.example.com/fail.wasm",
    },
    execPath: isWindows ? "C:\\usr\\bin\\node" : "/usr/bin/node",
    readFile: async () => {
      throw new Error("not found");
    },
    readFileSync: () => {
      throw new Error("not found");
    },
  });

  globals["fetch"] = ((url: string | URL) => {
    remoteAttempts.push(url.toString());
    if (url.toString().includes("fail.wasm")) {
      return Promise.reject(new Error("network error"));
    }
    return Promise.resolve({
      ok: true,
      arrayBuffer: () => Promise.resolve(bytes([2, 2])),
    } as Response);
  }) as typeof fetch;

  try {
    const loader = await importFreshLoaderModule();
    const bytes = await loader.getReleaseWasmBytes();
    assert.deepStrictEqual(Array.from(new Uint8Array(bytes)), [2, 2]);
    assert.deepStrictEqual(remoteAttempts.length, 2);
    assert.deepStrictEqual(
      remoteAttempts[0],
      "https://cdn.example.com/fail.wasm",
    );
    assert.match(remoteAttempts[1]!, jsrVersionedWasmUrlPattern);
  } finally {
    restoreNode();
    restoreGlobal("fetch", previousFetch);
  }
});

test("arenaWasmLoader - sync loading uses local candidates and populates async cache", async () => {
  resetReleaseWasmCache();
  const globals = globalThis as Record<string, unknown>;
  const previousFetch = globals["fetch"];

  let readFileSyncCalls = 0;
  const restoreNode = patchNode({
    env: {
      TYPED_SKI_WASM_PATH: undefined,
      TYPED_SKI_WASM_URL: undefined,
    },
    execPath: isWindows
      ? "C:\\usr\\local\\bin\\typed-ski"
      : "/usr/local/bin/typed-ski",
    readFile: async () => {
      throw new Error("should use readFileSync");
    },
    readFileSync: (path) => {
      readFileSyncCalls += 1;
      return Buffer.from([5, 4, 3]);
    },
  });
  globals["fetch"] = () => {
    throw new Error("fetch should not be called for sync load");
  };

  try {
    const loader = await importFreshLoaderModule();
    const syncBytes = loader.getReleaseWasmBytesSync();
    const syncBytesCached = loader.getReleaseWasmBytesSync();
    const asyncBytes = await loader.getReleaseWasmBytes();
    assert.deepStrictEqual(Array.from(new Uint8Array(syncBytes)), [5, 4, 3]);
    assert.deepStrictEqual(
      Array.from(new Uint8Array(syncBytesCached)),
      [5, 4, 3],
    );
    assert.deepStrictEqual(Array.from(new Uint8Array(asyncBytes)), [5, 4, 3]);
    assert.deepStrictEqual(readFileSyncCalls, 1);
    assert.deepStrictEqual(loader.getLastReleaseWasmLoadInfo(), {
      kind: "exec-path",
      url: execWasmUrl,
      via: "readFileSync",
    });
  } finally {
    restoreNode();
    restoreGlobal("fetch", previousFetch);
  }
});

test("arenaWasmLoader - sync loading throws without Node file access", async () => {
  resetReleaseWasmCache();
  const restoreNode = patchNode({
    readFile: undefined,
    readFileSync: () => {
      throw new Error("access denied");
    },
    env: {
      TYPED_SKI_WASM_PATH: undefined,
      TYPED_SKI_WASM_URL: undefined,
    },
  });

  try {
    const loader = await importFreshLoaderModule();
    assert.throws(() => loader.getReleaseWasmBytesSync(), {
      message:
        "Unable to load wasm/release.wasm synchronously. Set TYPED_SKI_WASM_PATH for synchronous loading.",
    });
  } finally {
    restoreNode();
  }
});

test("arenaWasmLoader - sync loading skips remote candidates and returns null before throw", async () => {
  resetReleaseWasmCache();
  const globals = globalThis as Record<string, unknown>;
  const previousFetch = globals["fetch"];

  const restoreNode = patchNode({
    env: {
      TYPED_SKI_WASM_PATH: undefined,
      TYPED_SKI_WASM_URL: "https://cdn.example.com/release.wasm",
    },
    execPath: isWindows ? "C:\\usr\\bin\\node" : "/usr/bin/node",
    readFile: async () => {
      throw new Error("not found");
    },
    readFileSync: () => {
      throw new Error("not found");
    },
  });

  globals["fetch"] = () => {
    throw new Error("fetch should not be called");
  };

  try {
    const loader = await importFreshLoaderModule();
    assert.throws(() => loader.getReleaseWasmBytesSync(), {
      message:
        "Unable to load wasm/release.wasm synchronously. Set TYPED_SKI_WASM_PATH for synchronous loading.",
    });
  } finally {
    restoreNode();
    restoreGlobal("fetch", previousFetch);
  }
});

test("arenaWasmLoader - tolerates process.env and execPath access errors", async () => {
  resetReleaseWasmCache();
  const globals = globalThis as Record<string, unknown>;
  const previousFetch = globals["fetch"];

  const restoreNode = patchNode({
    env: {}, // empty env
    readFile: async (path) => {
      const url =
        typeof path === "string" ? pathToFileURL(path).href : path.href;
      if (url === moduleWasmUrl) return Buffer.from([1]);
      throw new Error("not found");
    },
  });

  // Mock process.env to throw on access if possible, or just delete keys
  const originalEnv = process.env;
  const envProxy = new Proxy(originalEnv, {
    get: (target, prop) => {
      if (prop === "TYPED_SKI_WASM_PATH" || prop === "TYPED_SKI_WASM_URL") {
        throw new Error("env access denied");
      }
      return target[prop as keyof typeof target];
    },
  });
  Object.defineProperty(process, "env", {
    value: envProxy,
    configurable: true,
  });

  globals["fetch"] = (() =>
    Promise.resolve({
      ok: true,
      arrayBuffer: () => Promise.resolve(bytes([1])),
    } as Response)) as typeof fetch;

  try {
    const loader = await importFreshLoaderModule();
    const bytes = await loader.getReleaseWasmBytes();
    assert.deepStrictEqual(new Uint8Array(bytes).length, 1);
    assert.deepStrictEqual(
      loader.getLastReleaseWasmLoadInfo()?.kind,
      "module-path",
    );
  } finally {
    Object.defineProperty(process, "env", {
      value: originalEnv,
      configurable: true,
      writable: true,
    });
    restoreNode();
    restoreGlobal("fetch", previousFetch);
  }
});

test("arenaWasmLoader - resetReleaseWasmCache clears cached bytes and load info", async () => {
  resetReleaseWasmCache();
  const globals = globalThis as Record<string, unknown>;
  const previousFetch = globals["fetch"];
  let fetchCalls = 0;

  const restoreNode = patchNode({
    env: {
      TYPED_SKI_WASM_PATH: undefined,
      TYPED_SKI_WASM_URL: "https://cdn.example.com/cache.wasm",
    },
    execPath: isWindows ? "C:\\usr\\bin\\node" : "/usr/bin/node",
    readFile: async () => {
      throw new Error("local file candidates should be skipped");
    },
    readFileSync: () => {
      throw new Error("unused");
    },
  });

  globals["fetch"] = (() => {
    fetchCalls += 1;
    const payload = fetchCalls === 1 ? [8] : [9];
    return Promise.resolve({
      ok: true,
      arrayBuffer: () => Promise.resolve(bytes(payload)),
    } as Response);
  }) as typeof fetch;

  try {
    const loader = await importFreshLoaderModule();
    const first = await loader.getReleaseWasmBytes();
    const cached = await loader.getReleaseWasmBytes();
    assert.deepStrictEqual(Array.from(new Uint8Array(first)), [8]);
    assert.deepStrictEqual(Array.from(new Uint8Array(cached)), [8]);
    assert.deepStrictEqual(fetchCalls, 1);
    assert.deepStrictEqual(loader.getLastReleaseWasmLoadInfo(), {
      kind: "env-url",
      url: "https://cdn.example.com/cache.wasm",
      via: "fetch",
    });

    loader.resetReleaseWasmCache();
    assert.deepStrictEqual(loader.getLastReleaseWasmLoadInfo(), null);

    const reloaded = await loader.getReleaseWasmBytes();
    assert.deepStrictEqual(Array.from(new Uint8Array(reloaded)), [9]);
    assert.deepStrictEqual(fetchCalls, 2);
  } finally {
    resetReleaseWasmCache();
    restoreNode();
    restoreGlobal("fetch", previousFetch);
  }
});

test("arenaWasmLoader - formatReleaseWasmLoadInfo reports each source kind", () => {
  assert.deepStrictEqual(formatReleaseWasmLoadInfo(null), "unknown");
  assert.deepStrictEqual(
    formatReleaseWasmLoadInfo({
      kind: "env-path",
      url: "file:///tmp/release.wasm",
      via: "readFile",
    }),
    "env path (readFile)",
  );
  assert.deepStrictEqual(
    formatReleaseWasmLoadInfo({
      kind: "exec-path",
      url: execWasmUrl,
      via: "readFileSync",
    }),
    "compiled path (readFileSync)",
  );
  assert.deepStrictEqual(
    formatReleaseWasmLoadInfo({
      kind: "module-path",
      url: moduleWasmUrl,
      via: "readFile",
    }),
    "local path (readFile)",
  );
  assert.deepStrictEqual(
    formatReleaseWasmLoadInfo({
      kind: "env-url",
      url: "https://cdn.example.com/release.wasm",
      via: "fetch",
    }),
    "env URL fallback (fetch)",
  );
  assert.deepStrictEqual(
    formatReleaseWasmLoadInfo({
      kind: "version-url",
      url: `https://jsr.io/@maxdeliso/typed-ski/${VERSION}/wasm/release.wasm`,
      via: "fetch",
    }),
    "published JSR fallback (fetch)",
  );
});
