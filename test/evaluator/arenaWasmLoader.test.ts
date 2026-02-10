import { assertEquals, assertMatch, assertRejects, assertThrows } from "std/assert";

type LoaderModule = typeof import("../../lib/evaluator/arenaWasmLoader.ts");
const jsrVersionedWasmUrlPattern =
  /^https:\/\/jsr\.io\/@maxdeliso\/typed-ski\/\d+\.\d+\.\d+\/wasm\/release\.wasm$/;

const moduleWasmUrl = new URL(
  "../../wasm/release.wasm",
  new URL("../../lib/evaluator/arenaWasmLoader.ts", import.meta.url),
).href;

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
  execPath?: unknown;
  envGet?: unknown;
}

function patchDeno(overrides: DenoOverrides): () => void {
  const denoObject = Deno as unknown as Record<string, unknown>;
  const envObject = Deno.env as unknown as Record<string, unknown>;
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
  } finally {
    restoreDeno();
    restoreGlobal("fetch", previousFetch);
  }
});

Deno.test("arenaWasmLoader - relative env path is resolved and deduped against module path", async () => {
  const globals = globalThis as Record<string, unknown>;
  const previousFetch = globals["fetch"];
  const localAttempts: string[] = [];
  const remoteAttempts: string[] = [];

  const restoreDeno = patchDeno({
    envGet: (name: string) =>
      name === "TYPED_SKI_WASM_PATH" ? "../../wasm/release.wasm" : undefined,
    execPath: undefined,
    readFile: (candidate: URL) => {
      localAttempts.push(candidate.href);
      throw new Error("missing");
    },
    readFileSync: () => {
      throw new Error("unused");
    },
  });
  globals["fetch"] = (candidate: URL | string | Request) => {
    remoteAttempts.push(String(candidate));
    return new Response(null, { status: 404 });
  };

  try {
    const loader = await importFreshLoaderModule();
    await assertRejects(() => loader.getReleaseWasmBytes());
    assertEquals(localAttempts, [moduleWasmUrl]);
    assertEquals(remoteAttempts[0], moduleWasmUrl);
  } finally {
    restoreDeno();
    restoreGlobal("fetch", previousFetch);
  }
});

Deno.test("arenaWasmLoader - invalid env path and exec path are ignored", async () => {
  const globals = globalThis as Record<string, unknown>;
  const previousFetch = globals["fetch"];
  const localAttempts: string[] = [];

  const restoreDeno = patchDeno({
    envGet: (name: string) =>
      name === "TYPED_SKI_WASM_PATH" ? "http://[::1" : undefined,
    execPath: () => "%",
    readFile: (candidate: URL) => {
      localAttempts.push(candidate.href);
      throw new Error("missing");
    },
    readFileSync: () => {
      throw new Error("unused");
    },
  });
  globals["fetch"] = () => new Response(null, { status: 404 });

  try {
    const loader = await importFreshLoaderModule();
    await assertRejects(() => loader.getReleaseWasmBytes());
    assertEquals(localAttempts, [moduleWasmUrl]);
  } finally {
    restoreDeno();
    restoreGlobal("fetch", previousFetch);
  }
});

Deno.test("arenaWasmLoader - compiled exec path candidate is attempted before module path", async () => {
  const globals = globalThis as Record<string, unknown>;
  const previousFetch = globals["fetch"];
  const localAttempts: string[] = [];

  const restoreDeno = patchDeno({
    envGet: () => undefined,
    execPath: () => "/tmp/deno-compile-tripc/tripc",
    readFile: (candidate: URL) => {
      localAttempts.push(candidate.href);
      throw new Error("missing");
    },
    readFileSync: () => {
      throw new Error("unused");
    },
  });
  globals["fetch"] = () => new Response(null, { status: 404 });

  try {
    const loader = await importFreshLoaderModule();
    await assertRejects(() => loader.getReleaseWasmBytes());
    assertEquals(localAttempts.slice(0, 2), [
      "file:///tmp/wasm/release.wasm",
      moduleWasmUrl,
    ]);
  } finally {
    restoreDeno();
    restoreGlobal("fetch", previousFetch);
  }
});

Deno.test("arenaWasmLoader - deno runtime exec path and file env URL are ignored as network fallbacks", async () => {
  const globals = globalThis as Record<string, unknown>;
  const previousFetch = globals["fetch"];
  const localAttempts: string[] = [];
  const remoteAttempts: string[] = [];

  const restoreDeno = patchDeno({
    envGet: (name: string) =>
      name === "TYPED_SKI_WASM_URL" ? "file:///tmp/release.wasm" : undefined,
    execPath: () => "/usr/bin/deno",
    readFile: (candidate: URL) => {
      localAttempts.push(candidate.href);
      throw new Error("missing");
    },
    readFileSync: () => {
      throw new Error("unused");
    },
  });
  globals["fetch"] = (candidate: URL | string | Request) => {
    remoteAttempts.push(String(candidate));
    return new Response(null, { status: 404 });
  };

  try {
    const loader = await importFreshLoaderModule();
    await assertRejects(() => loader.getReleaseWasmBytes());
    assertEquals(localAttempts, [moduleWasmUrl]);
    assertEquals(remoteAttempts.length, 2);
    assertEquals(remoteAttempts[0], moduleWasmUrl);
    assertMatch(remoteAttempts[1] ?? "", jsrVersionedWasmUrlPattern);
  } finally {
    restoreDeno();
    restoreGlobal("fetch", previousFetch);
  }
});

Deno.test("arenaWasmLoader - async loading falls back to remote fetch and reuses in-flight promise", async () => {
  const globals = globalThis as Record<string, unknown>;
  const previousFetch = globals["fetch"];

  const restoreDeno = patchDeno({
    readFile: undefined,
    readFileSync: undefined,
    envGet: () => undefined,
  });

  let fetchCalls = 0;
  globals["fetch"] = async (input: URL | string | Request) => {
    fetchCalls += 1;
    const url = String(input);
    if (url.startsWith("file:")) {
      return new Response(null, { status: 404 });
    }
    await Promise.resolve();
    return new Response(bytes([9, 8, 7]), { status: 200 });
  };

  try {
    const loader = await importFreshLoaderModule();
    const [first, second] = await Promise.all([
      loader.getReleaseWasmBytes(),
      loader.getReleaseWasmBytes(),
    ]);
    assertEquals(Array.from(new Uint8Array(first)), [9, 8, 7]);
    assertEquals(Array.from(new Uint8Array(second)), [9, 8, 7]);
    assertEquals(fetchCalls, 2);
  } finally {
    restoreDeno();
    restoreGlobal("fetch", previousFetch);
  }
});

Deno.test("arenaWasmLoader - http env URL fallback is attempted before version fallback", async () => {
  const globals = globalThis as Record<string, unknown>;
  const previousFetch = globals["fetch"];
  const remoteAttempts: string[] = [];

  const restoreDeno = patchDeno({
    readFile: undefined,
    readFileSync: undefined,
    envGet: (name: string) =>
      name === "TYPED_SKI_WASM_URL"
        ? "https://cdn.example.com/typed-ski/release.wasm"
        : undefined,
  });
  globals["fetch"] = (input: URL | string | Request) => {
    const url = String(input);
    remoteAttempts.push(url);
    if (url === "https://cdn.example.com/typed-ski/release.wasm") {
      return new Response(bytes([4, 4, 4]), { status: 200 });
    }
    return new Response(null, { status: 404 });
  };

  try {
    const loader = await importFreshLoaderModule();
    const loaded = await loader.getReleaseWasmBytes();
    assertEquals(Array.from(new Uint8Array(loaded)), [4, 4, 4]);
    assertEquals(remoteAttempts.slice(0, 2), [
      moduleWasmUrl,
      "https://cdn.example.com/typed-ski/release.wasm",
    ]);
  } finally {
    restoreDeno();
    restoreGlobal("fetch", previousFetch);
  }
});

Deno.test("arenaWasmLoader - invalid env URL falls back to version URL", async () => {
  const globals = globalThis as Record<string, unknown>;
  const previousFetch = globals["fetch"];
  const remoteAttempts: string[] = [];

  const restoreDeno = patchDeno({
    readFile: undefined,
    readFileSync: undefined,
    envGet: (name: string) =>
      name === "TYPED_SKI_WASM_URL" ? "http://[::1" : undefined,
    execPath: undefined,
  });
  globals["fetch"] = (input: URL | string | Request) => {
    const url = String(input);
    remoteAttempts.push(url);
    if (url.startsWith("https://jsr.io/")) {
      return new Response(bytes([3, 3, 3]), { status: 200 });
    }
    return new Response(null, { status: 404 });
  };

  try {
    const loader = await importFreshLoaderModule();
    const loaded = await loader.getReleaseWasmBytes();
    assertEquals(Array.from(new Uint8Array(loaded)), [3, 3, 3]);
    assertMatch(remoteAttempts.at(-1) ?? "", jsrVersionedWasmUrlPattern);
  } finally {
    restoreDeno();
    restoreGlobal("fetch", previousFetch);
  }
});

Deno.test("arenaWasmLoader - async loading throws when all candidates fail", async () => {
  const globals = globalThis as Record<string, unknown>;
  const previousFetch = globals["fetch"];

  const restoreDeno = patchDeno({
    envGet: () => undefined,
    execPath: () => "/usr/local/bin/typed-ski",
    readFile: () => {
      throw new Error("missing");
    },
    readFileSync: () => {
      throw new Error("missing");
    },
  });
  globals["fetch"] = () => new Response(null, { status: 404 });

  try {
    const loader = await importFreshLoaderModule();
    await assertRejects(
      () => loader.getReleaseWasmBytes(),
      Error,
      "Unable to load wasm/release.wasm",
    );
  } finally {
    restoreDeno();
    restoreGlobal("fetch", previousFetch);
  }
});

Deno.test("arenaWasmLoader - async loading continues after fetch error", async () => {
  const globals = globalThis as Record<string, unknown>;
  const previousFetch = globals["fetch"];

  const restoreDeno = patchDeno({
    readFile: undefined,
    readFileSync: undefined,
    envGet: () => undefined,
  });
  let fetchCalls = 0;
  globals["fetch"] = (input: URL | string | Request) => {
    fetchCalls += 1;
    const url = String(input);
    if (url.startsWith("file:")) {
      throw new Error("network error");
    }
    return new Response(bytes([6, 6, 6]), { status: 200 });
  };

  try {
    const loader = await importFreshLoaderModule();
    const loaded = await loader.getReleaseWasmBytes();
    assertEquals(Array.from(new Uint8Array(loaded)), [6, 6, 6]);
    assertEquals(fetchCalls, 2);
  } finally {
    restoreDeno();
    restoreGlobal("fetch", previousFetch);
  }
});

Deno.test("arenaWasmLoader - sync loading uses local candidates and populates async cache", async () => {
  const globals = globalThis as Record<string, unknown>;
  const previousFetch = globals["fetch"];

  let readFileSyncCalls = 0;
  const restoreDeno = patchDeno({
    envGet: () => undefined,
    execPath: () => "/usr/local/bin/typed-ski",
    readFile: () => {
      throw new Error("readFile should not be needed after sync cache");
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
  } finally {
    restoreDeno();
    restoreGlobal("fetch", previousFetch);
  }
});

Deno.test("arenaWasmLoader - sync loading throws without Deno file access", async () => {
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
      "Unable to load wasm/release.wasm synchronously",
    );
  } finally {
    restoreDeno();
  }
});

Deno.test("arenaWasmLoader - sync loading skips remote candidates and returns null before throw", async () => {
  const restoreDeno = patchDeno({
    envGet: (name: string) =>
      name === "TYPED_SKI_WASM_PATH"
        ? "https://cdn.example.com/release.wasm"
        : undefined,
    readFile: () => new Uint8Array([1]),
    readFileSync: () => {
      throw new Error("missing file");
    },
  });

  try {
    const loader = await importFreshLoaderModule();
    assertThrows(
      () => loader.getReleaseWasmBytesSync(),
      Error,
      "Unable to load wasm/release.wasm synchronously",
    );
  } finally {
    restoreDeno();
  }
});

Deno.test("arenaWasmLoader - tolerates Deno.env.get and execPath errors", async () => {
  const globals = globalThis as Record<string, unknown>;
  const previousFetch = globals["fetch"];

  const restoreDeno = patchDeno({
    envGet: () => {
      throw new Error("env unavailable");
    },
    execPath: () => {
      throw new Error("exec unavailable");
    },
    readFile: () => new Uint8Array([2, 2, 2]),
    readFileSync: () => new Uint8Array([2, 2, 2]),
  });
  globals["fetch"] = () => {
    throw new Error("fetch should not be called");
  };

  try {
    const loader = await importFreshLoaderModule();
    const loaded = await loader.getReleaseWasmBytes();
    assertEquals(Array.from(new Uint8Array(loaded)), [2, 2, 2]);
  } finally {
    restoreDeno();
    restoreGlobal("fetch", previousFetch);
  }
});
