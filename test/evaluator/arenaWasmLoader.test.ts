import {
  assertEquals,
  assertMatch,
  assertRejects,
  assertThrows,
} from "std/assert";

type LoaderModule = typeof import("../../lib/evaluator/arenaWasmLoader.ts");
import {
  formatReleaseWasmLoadInfo,
  getLastReleaseWasmLoadInfo,
  getReleaseWasmBytes,
  resetReleaseWasmCache,
} from "../../lib/evaluator/arenaWasmLoader.ts";
import { VERSION } from "../../lib/shared/version.generated.ts";

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const jsrVersionedWasmUrlPattern = new RegExp(
  `^https:\\/\\/jsr\\.io\\/@maxdeliso\\/typed-ski\\/${
    escapeRegExp(VERSION)
  }\\/wasm\\/release\\.wasm$`,
);

const moduleWasmUrl = new URL(
  "../../wasm/release.wasm",
  new URL("../../lib/evaluator/arenaWasmLoader.ts", import.meta.url),
).href;

const compiledWasmUrl = "file:///tmp/wasm/release.wasm";
const execWasmUrl = "file:///usr/local/wasm/release.wasm";

async function importFreshLoaderModule(): Promise<LoaderModule> {
  return await import(
    `../../lib/evaluator/arenaWasmLoader.ts?case=${crypto.randomUUID()}`
  );
}

function bytes(values: number[]): ArrayBuffer {
  return new Uint8Array(values).buffer;
}

function restoreGlobal(
  name: "Deno" | "fetch",
  previous: unknown,
): void {
  const globals = globalThis as Record<string, unknown>;
  if (previous === undefined) {
    delete globals[name];
    return;
  }
  globals[name] = previous;
}

interface DenoOverrides {
  readFile?: unknown;
  readFileSync?: unknown;
  envGet?: (name: string) => string | undefined;
  execPath?: () => string;
}

function patchDeno(overrides: DenoOverrides) {
  const globals = globalThis as Record<string, unknown>;
  if (!globals["Deno"]) globals["Deno"] = {};
  const denoObject = globals["Deno"] as Record<string, unknown>;
  if (!denoObject["env"]) denoObject["env"] = {};
  const envObject = denoObject["env"] as Record<string, unknown>;

  const previous = {
    readFile: denoObject["readFile"],
    readFileSync: denoObject["readFileSync"],
    execPath: denoObject["execPath"],
    envGet: envObject["get"],
  };

  if ("readFile" in overrides) denoObject["readFile"] = overrides.readFile;
  if ("readFileSync" in overrides) {
    denoObject["readFileSync"] = overrides.readFileSync;
  }
  if ("execPath" in overrides) denoObject["execPath"] = overrides.execPath;
  if ("envGet" in overrides) envObject["get"] = overrides.envGet;
  return () => {
    denoObject["readFile"] = previous.readFile;
    denoObject["readFileSync"] = previous.readFileSync;
    denoObject["execPath"] = previous.execPath;
    envObject["get"] = previous.envGet;
  };
}

Deno.test("arenaWasmLoader - async loading prefers local file in Deno and caches bytes", async () => {
  resetReleaseWasmCache();
  const globals = globalThis as Record<string, unknown>;
  const previousFetch = globals["fetch"];

  let readFileCalls = 0;
  const restoreDeno = patchDeno({
    envGet: () => undefined,
    execPath: () => "/usr/local/bin/typed-ski",
    readFile: () => {
      readFileCalls += 1;
      return new Uint8Array([1, 2, 3]);
    },
    readFileSync: () => new Uint8Array([7, 8, 9]),
  });
  globals["fetch"] = () => {
    throw new Error("fetch should not be called");
  };

  try {
    const loader = await importFreshLoaderModule();
    const first = await loader.getReleaseWasmBytes();
    const second = await loader.getReleaseWasmBytes();
    assertEquals(Array.from(new Uint8Array(first)), [1, 2, 3]);
    assertEquals(Array.from(new Uint8Array(second)), [1, 2, 3]);
    assertEquals(readFileCalls, 1);
    assertEquals(loader.getLastReleaseWasmLoadInfo(), {
      kind: "exec-path",
      url: execWasmUrl,
      via: "readFile",
    });
  } finally {
    restoreDeno();
    restoreGlobal("fetch", previousFetch);
  }
});

Deno.test("arenaWasmLoader - Windows absolute env paths normalize to file URLs", async () => {
  resetReleaseWasmCache();
  const globals = globalThis as Record<string, unknown>;
  const previousFetch = globals["fetch"];
  const localAttempts: string[] = [];

  const restoreDeno = patchDeno({
    envGet: (name: string) =>
      name === "TYPED_SKI_WASM_PATH" ? "C:\\temp\\release.wasm" : undefined,
    execPath: () => "/usr/bin/deno",
    readFile: (url: URL) => {
      localAttempts.push(url.href);
      return new Uint8Array([9, 9]);
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
    assertEquals(Array.from(new Uint8Array(loaded)), [9, 9]);
    assertEquals(localAttempts, ["file:///C:/temp/release.wasm"]);
    assertEquals(loader.getLastReleaseWasmLoadInfo(), {
      kind: "env-path",
      url: "file:///C:/temp/release.wasm",
      via: "readFile",
    });
  } finally {
    restoreDeno();
    restoreGlobal("fetch", previousFetch);
  }
});

Deno.test("arenaWasmLoader - compiled exec path falls back to module path", async () => {
  resetReleaseWasmCache();
  const globals = globalThis as Record<string, unknown>;
  const previousFetch = globals["fetch"];
  const localAttempts: string[] = [];

  const restoreDeno = patchDeno({
    envGet: () => undefined,
    execPath: () => "/tmp/deno-compile-tripc/tripc",
    readFile: (url: URL) => {
      localAttempts.push(url.href);
      if (url.href === compiledWasmUrl) {
        throw new Error("missing compiled wasm");
      }
      if (url.href === moduleWasmUrl) {
        return new Uint8Array([4, 4]);
      }
      throw new Error(`unexpected candidate: ${url.href}`);
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
    assertEquals(Array.from(new Uint8Array(loaded)), [4, 4]);
    assertEquals(localAttempts.slice(0, 2), [compiledWasmUrl, moduleWasmUrl]);
    assertEquals(loader.getLastReleaseWasmLoadInfo(), {
      kind: "module-path",
      url: moduleWasmUrl,
      via: "readFile",
    });
  } finally {
    restoreDeno();
    restoreGlobal("fetch", previousFetch);
  }
});

Deno.test("arenaWasmLoader - invalid env path and exec path are ignored", async () => {
  resetReleaseWasmCache();
  const globals = globalThis as Record<string, unknown>;
  const previousFetch = globals["fetch"];
  const localAttempts: string[] = [];

  const restoreDeno = patchDeno({
    envGet: (name: string) =>
      name === "TYPED_SKI_WASM_PATH"
        ? "relative/path/without/slashes"
        : undefined,
    execPath: () => "/usr/bin/deno", // should be ignored
    readFile: (url: URL) => {
      localAttempts.push(url.href);
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
    });

  try {
    const loader = await importFreshLoaderModule();
    await loader.getReleaseWasmBytes();

    assertEquals(localAttempts, [
      new URL(
        "relative/path/without/slashes",
        new URL("../../lib/evaluator/arenaWasmLoader.ts", import.meta.url),
      ).href,
    ]);
  } finally {
    restoreDeno();
    restoreGlobal("fetch", previousFetch);
  }
});

Deno.test("arenaWasmLoader - deno runtime exec path and file env URL are ignored as network fallbacks", async () => {
  resetReleaseWasmCache();
  const globals = globalThis as Record<string, unknown>;
  const previousFetch = globals["fetch"];
  const localAttempts: string[] = [];
  const remoteAttempts: string[] = [];

  const restoreDeno = patchDeno({
    envGet: (name: string) =>
      name === "TYPED_SKI_WASM_URL"
        ? "https://cdn.example.com/release.wasm"
        : undefined,
    execPath: () => "/usr/bin/deno",
    readFile: () => {
      // Standard local paths are skipped when TYPED_SKI_WASM_URL is provided.
      throw new Error("not found");
    },
    readFileSync: () => {
      throw new Error("not found");
    },
  });

  globals["fetch"] = (url: string | URL) => {
    remoteAttempts.push(url.toString());
    // Fail the first one to see it attempt the versioned fallback.
    if (url.toString() === "https://cdn.example.com/release.wasm") {
      return Promise.resolve({ ok: false });
    }
    return Promise.resolve({
      ok: true,
      arrayBuffer: () => Promise.resolve(bytes([1])),
    });
  };

  try {
    const loader = await importFreshLoaderModule();
    await loader.getReleaseWasmBytes();

    assertEquals(localAttempts, []);
    assertEquals(remoteAttempts[0], "https://cdn.example.com/release.wasm");
    assertMatch(remoteAttempts[1]!, jsrVersionedWasmUrlPattern);
  } finally {
    restoreDeno();
    restoreGlobal("fetch", previousFetch);
  }
});

Deno.test("arenaWasmLoader - env URL success bypasses local candidates", async () => {
  resetReleaseWasmCache();
  const globals = globalThis as Record<string, unknown>;
  const previousFetch = globals["fetch"];
  const localAttempts: string[] = [];
  const remoteAttempts: string[] = [];

  const restoreDeno = patchDeno({
    envGet: (name: string) =>
      name === "TYPED_SKI_WASM_URL"
        ? "https://cdn.example.com/success.wasm"
        : undefined,
    execPath: () => "/tmp/deno-compile-tripc/tripc",
    readFile: (url: URL) => {
      localAttempts.push(url.href);
      throw new Error("local file candidates should be skipped");
    },
    readFileSync: () => {
      throw new Error("unused");
    },
  });

  globals["fetch"] = (url: string | URL) => {
    remoteAttempts.push(url.toString());
    return Promise.resolve({
      ok: true,
      arrayBuffer: () => Promise.resolve(bytes([7, 7, 7])),
    });
  };

  try {
    const loader = await importFreshLoaderModule();
    const loaded = await loader.getReleaseWasmBytes();
    assertEquals(Array.from(new Uint8Array(loaded)), [7, 7, 7]);
    assertEquals(localAttempts, []);
    assertEquals(remoteAttempts, ["https://cdn.example.com/success.wasm"]);
    assertEquals(loader.getLastReleaseWasmLoadInfo(), {
      kind: "env-url",
      url: "https://cdn.example.com/success.wasm",
      via: "fetch",
    });
  } finally {
    restoreDeno();
    restoreGlobal("fetch", previousFetch);
  }
});

Deno.test("arenaWasmLoader - async loading throws when all candidates fail", async () => {
  resetReleaseWasmCache();
  const globals = globalThis as Record<string, unknown>;
  const previousFetch = globals["fetch"];

  const restoreDeno = patchDeno({
    envGet: () => undefined,
    execPath: () => "/usr/bin/deno",
    readFile: () => {
      throw new Error("not found");
    },
    readFileSync: () => {
      throw new Error("not found");
    },
  });

  globals["fetch"] = () => Promise.resolve({ ok: false });

  try {
    const loader = await importFreshLoaderModule();
    await assertRejects(
      () => loader.getReleaseWasmBytes(),
      Error,
      "Unable to load wasm/release.wasm. Set TYPED_SKI_WASM_PATH or TYPED_SKI_WASM_URL to override.",
    );
  } finally {
    restoreDeno();
    restoreGlobal("fetch", previousFetch);
  }
});

Deno.test("arenaWasmLoader - async loading continues after fetch error", async () => {
  resetReleaseWasmCache();
  const globals = globalThis as Record<string, unknown>;
  const previousFetch = globals["fetch"];
  const remoteAttempts: string[] = [];

  const restoreDeno = patchDeno({
    envGet: (name: string) =>
      name === "TYPED_SKI_WASM_URL"
        ? "https://cdn.example.com/fail.wasm"
        : undefined,
    execPath: () => "/usr/bin/deno",
    readFile: () => {
      throw new Error("not found");
    },
    readFileSync: () => {
      throw new Error("not found");
    },
  });

  globals["fetch"] = (url: string | URL) => {
    remoteAttempts.push(url.toString());
    if (url.toString().includes("fail.wasm")) {
      return Promise.reject(new Error("network error"));
    }
    return Promise.resolve({
      ok: true,
      arrayBuffer: () => Promise.resolve(bytes([2, 2])),
    });
  };

  try {
    const loader = await importFreshLoaderModule();
    const bytes = await loader.getReleaseWasmBytes();
    assertEquals(Array.from(new Uint8Array(bytes)), [2, 2]);
    assertEquals(remoteAttempts.length, 2);
    assertEquals(remoteAttempts[0], "https://cdn.example.com/fail.wasm");
    assertMatch(remoteAttempts[1]!, jsrVersionedWasmUrlPattern);
  } finally {
    restoreDeno();
    restoreGlobal("fetch", previousFetch);
  }
});

Deno.test("arenaWasmLoader - sync loading uses local candidates and populates async cache", async () => {
  resetReleaseWasmCache();
  const globals = globalThis as Record<string, unknown>;
  const previousFetch = globals["fetch"];

  let readFileSyncCalls = 0;
  const restoreDeno = patchDeno({
    envGet: () => undefined,
    execPath: () => "/usr/local/bin/typed-ski",
    readFile: () => {
      throw new Error("should use readFileSync");
    },
    readFileSync: () => {
      readFileSyncCalls += 1;
      return new Uint8Array([5, 4, 3]);
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
    assertEquals(Array.from(new Uint8Array(syncBytes)), [5, 4, 3]);
    assertEquals(Array.from(new Uint8Array(syncBytesCached)), [5, 4, 3]);
    assertEquals(Array.from(new Uint8Array(asyncBytes)), [5, 4, 3]);
    assertEquals(readFileSyncCalls, 1);
    assertEquals(loader.getLastReleaseWasmLoadInfo(), {
      kind: "exec-path",
      url: execWasmUrl,
      via: "readFileSync",
    });
  } finally {
    restoreDeno();
    restoreGlobal("fetch", previousFetch);
  }
});

Deno.test("arenaWasmLoader - sync loading throws without Deno file access", async () => {
  resetReleaseWasmCache();
  const restoreDeno = patchDeno({
    readFile: undefined,
    readFileSync: undefined,
    envGet: () => undefined,
  });

  try {
    const loader = await importFreshLoaderModule();
    assertThrows(
      () => loader.getReleaseWasmBytesSync(),
      Error,
      "Unable to load wasm/release.wasm synchronously. Set TYPED_SKI_WASM_PATH for synchronous loading.",
    );
  } finally {
    restoreDeno();
  }
});

Deno.test("arenaWasmLoader - sync loading skips remote candidates and returns null before throw", async () => {
  resetReleaseWasmCache();
  const globals = globalThis as Record<string, unknown>;
  const previousFetch = globals["fetch"];

  const restoreDeno = patchDeno({
    envGet: (name: string) =>
      name === "TYPED_SKI_WASM_URL"
        ? "https://cdn.example.com/release.wasm"
        : undefined,
    execPath: () => "/usr/bin/deno",
    readFile: () => {
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
    assertThrows(
      () => loader.getReleaseWasmBytesSync(),
      Error,
      "Unable to load wasm/release.wasm synchronously. Set TYPED_SKI_WASM_PATH for synchronous loading.",
    );
  } finally {
    restoreDeno();
    restoreGlobal("fetch", previousFetch);
  }
});

Deno.test("arenaWasmLoader - tolerates Deno.env.get and execPath errors", async () => {
  resetReleaseWasmCache();
  const globals = globalThis as Record<string, unknown>;
  const previousFetch = globals["fetch"];

  const restoreDeno = patchDeno({
    envGet: () => {
      throw new Error("env access denied");
    },
    execPath: () => {
      throw new Error("execPath access denied");
    },
    readFile: (url: URL) => {
      if (url.href === moduleWasmUrl) return new Uint8Array([1]);
      throw new Error("not found");
    },
  });

  globals["fetch"] = () =>
    Promise.resolve({
      ok: true,
      arrayBuffer: () => Promise.resolve(bytes([1])),
    });

  try {
    const loader = await importFreshLoaderModule();
    const bytes = await loader.getReleaseWasmBytes();
    assertEquals(new Uint8Array(bytes).length, 1);
    assertEquals(loader.getLastReleaseWasmLoadInfo()?.kind, "module-path");
  } finally {
    restoreDeno();
    restoreGlobal("fetch", previousFetch);
  }
});

Deno.test("arenaWasmLoader - resetReleaseWasmCache clears cached bytes and load info", async () => {
  resetReleaseWasmCache();
  const globals = globalThis as Record<string, unknown>;
  const previousFetch = globals["fetch"];
  let fetchCalls = 0;

  const restoreDeno = patchDeno({
    envGet: (name: string) =>
      name === "TYPED_SKI_WASM_URL"
        ? "https://cdn.example.com/cache.wasm"
        : undefined,
    execPath: () => "/usr/bin/deno",
    readFile: () => {
      throw new Error("local file candidates should be skipped");
    },
    readFileSync: () => {
      throw new Error("unused");
    },
  });

  globals["fetch"] = () => {
    fetchCalls += 1;
    const payload = fetchCalls === 1 ? [8] : [9];
    return Promise.resolve({
      ok: true,
      arrayBuffer: () => Promise.resolve(bytes(payload)),
    });
  };

  try {
    const first = await getReleaseWasmBytes();
    const cached = await getReleaseWasmBytes();
    assertEquals(Array.from(new Uint8Array(first)), [8]);
    assertEquals(Array.from(new Uint8Array(cached)), [8]);
    assertEquals(fetchCalls, 1);
    assertEquals(getLastReleaseWasmLoadInfo(), {
      kind: "env-url",
      url: "https://cdn.example.com/cache.wasm",
      via: "fetch",
    });

    resetReleaseWasmCache();
    assertEquals(getLastReleaseWasmLoadInfo(), null);

    const reloaded = await getReleaseWasmBytes();
    assertEquals(Array.from(new Uint8Array(reloaded)), [9]);
    assertEquals(fetchCalls, 2);
  } finally {
    resetReleaseWasmCache();
    restoreDeno();
    restoreGlobal("fetch", previousFetch);
  }
});

Deno.test("arenaWasmLoader - formatReleaseWasmLoadInfo reports each source kind", () => {
  assertEquals(formatReleaseWasmLoadInfo(null), "unknown");
  assertEquals(
    formatReleaseWasmLoadInfo({
      kind: "env-path",
      url: "file:///tmp/release.wasm",
      via: "readFile",
    }),
    "env path (readFile)",
  );
  assertEquals(
    formatReleaseWasmLoadInfo({
      kind: "exec-path",
      url: execWasmUrl,
      via: "readFileSync",
    }),
    "compiled path (readFileSync)",
  );
  assertEquals(
    formatReleaseWasmLoadInfo({
      kind: "module-path",
      url: moduleWasmUrl,
      via: "readFile",
    }),
    "local path (readFile)",
  );
  assertEquals(
    formatReleaseWasmLoadInfo({
      kind: "env-url",
      url: "https://cdn.example.com/release.wasm",
      via: "fetch",
    }),
    "env URL fallback (fetch)",
  );
  assertEquals(
    formatReleaseWasmLoadInfo({
      kind: "version-url",
      url: `https://jsr.io/@maxdeliso/typed-ski/${VERSION}/wasm/release.wasm`,
      via: "fetch",
    }),
    "published JSR fallback (fetch)",
  );
});
