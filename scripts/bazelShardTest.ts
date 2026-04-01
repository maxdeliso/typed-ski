#!/usr/bin/env -S deno run -A

import { dirname, join, toFileUrl } from "std/path";

function readTestTimeoutMs(): number {
  const rawValue = Deno.env.get("TEST_TIMEOUT");
  if (!rawValue) {
    return 30_000;
  }

  const seconds = Number(rawValue);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error(`Invalid TEST_TIMEOUT value: ${rawValue}`);
  }
  return Math.ceil(seconds * 1000);
}

function remainingTimeoutMs(deadline: number): number {
  return Math.max(0, deadline - Date.now());
}

function defaultDenoCacheDir(testTmpDir: string): string {
  const explicit = Deno.env.get("TYPED_SKI_DENO_DIR");
  if (explicit) {
    return explicit;
  }

  if (Deno.build.os === "windows") {
    const windowsCacheRoot = Deno.env.get("LOCALAPPDATA") ??
      Deno.env.get("APPDATA");
    if (windowsCacheRoot) {
      return join(windowsCacheRoot, "typed-ski", "deno-cache");
    }
  }

  const home = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE");
  if (home) {
    return join(home, ".cache", "typed-ski-deno-cache");
  }

  return join(testTmpDir, "typed-ski-deno-cache");
}

async function copyTree(sourceDir: string, targetDir: string): Promise<void> {
  await Deno.mkdir(targetDir, { recursive: true });

  for await (const entry of Deno.readDir(sourceDir)) {
    const sourcePath = join(sourceDir, entry.name);
    const targetPath = join(targetDir, entry.name);
    const stat = await Deno.stat(sourcePath);

    if (stat.isDirectory) {
      await copyTree(sourcePath, targetPath);
      continue;
    }
    if (!stat.isFile) {
      continue;
    }

    await Deno.mkdir(dirname(targetPath), { recursive: true });
    await Deno.copyFile(sourcePath, targetPath);
    if (Deno.build.os !== "windows" && stat.mode !== null) {
      await Deno.chmod(targetPath, stat.mode).catch(() => {});
    }
  }
}

async function copyInjectedFile(
  sourcePath: string | undefined,
  targetPath: string,
): Promise<boolean> {
  if (!sourcePath) {
    return false;
  }
  const stat = await Deno.stat(sourcePath);
  if (!stat.isFile) {
    return false;
  }
  await Deno.mkdir(dirname(targetPath), { recursive: true });
  await Deno.copyFile(sourcePath, targetPath);
  if (Deno.build.os !== "windows" && stat.mode !== null) {
    await Deno.chmod(targetPath, stat.mode).catch(() => {});
  }
  return true;
}

const deadline = Date.now() + readTestTimeoutMs();
const sourceRoot = Deno.cwd();
const testTmpDir = Deno.env.get("TEST_TMPDIR") ?? await Deno.makeTempDir();
const workspaceCopy = join(
  testTmpDir,
  "typed-ski-bazel-test",
  crypto.randomUUID(),
);
const tempRoot = join(workspaceCopy, ".tmp");
const denoCacheDir = defaultDenoCacheDir(testTmpDir);
const buildTempDir = join(tempRoot, "build");
const processTempDir = join(tempRoot, "temp");

await Deno.remove(workspaceCopy, { recursive: true }).catch(() => {});
await copyTree(sourceRoot, workspaceCopy);
await Deno.mkdir(tempRoot, { recursive: true });

const distInjected = await Promise.all([
  copyInjectedFile(
    Deno.env.get("TYPED_SKI_DIST_JS_PATH") ?? undefined,
    join(workspaceCopy, "dist", "tripc.js"),
  ),
  copyInjectedFile(
    Deno.env.get("TYPED_SKI_DIST_MIN_JS_PATH") ?? undefined,
    join(workspaceCopy, "dist", "tripc.min.js"),
  ),
  copyInjectedFile(
    Deno.env.get("TYPED_SKI_DIST_NODE_JS_PATH") ?? undefined,
    join(workspaceCopy, "dist", "tripc.node.js"),
  ),
  copyInjectedFile(
    Deno.env.get("TYPED_SKI_DIST_BIN_PATH") ?? undefined,
    join(
      workspaceCopy,
      "dist",
      Deno.build.os === "windows" ? "tripc.exe" : "tripc",
    ),
  ),
]);

const childEnv: Record<string, string> = {
  ...Deno.env.toObject(),
  TYPED_SKI_SKIP_DENO_VERSION_CHECK: "1",
  TYPED_SKI_DENO_DIR: denoCacheDir,
  TYPED_SKI_BUILD_TEMP_DIR: buildTempDir,
  TEMP: processTempDir,
  TMP: processTempDir,
};
if (distInjected.some(Boolean)) {
  childEnv.TYPED_SKI_DIST_READY = "1";
}

await Deno.mkdir(buildTempDir, { recursive: true });
await Deno.mkdir(processTempDir, { recursive: true });

const rawWasmPath = childEnv.TYPED_SKI_WASM_PATH;
if (rawWasmPath && !/^[a-z]+:\/\//i.test(rawWasmPath)) {
  childEnv.TYPED_SKI_WASM_PATH = toFileUrl(rawWasmPath).href;
}

const timeoutMs = remainingTimeoutMs(deadline);
if (timeoutMs === 0) {
  throw new Error("Shard exceeded TEST_TIMEOUT before test execution began");
}

const child = new Deno.Command(
  Deno.execPath(),
  {
    args: ["run", "-A", "scripts/bazel.ts", "bazel-test-shard"],
    cwd: workspaceCopy,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    env: childEnv,
  },
).spawn();

let didTimeout = false;
const timeoutId = setTimeout(() => {
  didTimeout = true;
  console.error(
    `Shard exceeded TEST_TIMEOUT=${Math.ceil(timeoutMs / 1000)}s; terminating.`,
  );
  try {
    child.kill("SIGKILL");
  } catch {
    // Ignore already-exited children while enforcing the timeout.
  }
}, timeoutMs);

const { code } = await child.status;
clearTimeout(timeoutId);

if (didTimeout) {
  Deno.exit(1);
}

Deno.exit(code);
