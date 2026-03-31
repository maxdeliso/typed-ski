import {
  assertEquals,
  assertMatch,
  assertRejects,
  assertThrows,
} from "std/assert";

type LoaderModule = typeof import("../../lib/evaluator/arenaWasmLoader.ts");
import { resetReleaseWasmCache } from "../../lib/evaluator/arenaWasmLoader.ts";
import { VERSION } from "../../lib/shared/version.generated.ts";

const jsrVersionedWasmUrlPattern = new RegExp(
  `^https:\\/\\/jsr\\.io\\/@maxdeliso\\/typed-ski\\/${
    VERSION.replace(/\./g, "\\.")
  }\\/wasm\\/release\\.wasm$`,
);

const moduleWasmUrl = new URL(
  "../../wasm/release.wasm",
  new URL("../../lib/evaluator/arenaWasmLoader.ts", import.meta.url),
).href;

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
