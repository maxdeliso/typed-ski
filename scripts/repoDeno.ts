import { dirname, fromFileUrl, join, resolve } from "std/path";

type DenoJson = {
  version?: unknown;
  toolchain?: {
    deno?: unknown;
  };
};

const __dirname = dirname(fromFileUrl(import.meta.url));

export const PROJECT_ROOT = resolve(join(__dirname, ".."));
const DENO_JSON_PATH = join(PROJECT_ROOT, "deno.jsonc");
const TOOLCHAIN_ROOT = (() => {
  const override = Deno.env.get("TYPED_SKI_DENO_TOOLCHAIN_DIR");
  if (override) return override;
  if (Deno.build.os === "windows") {
    const windowsCacheRoot = Deno.env.get("LOCALAPPDATA") ??
      Deno.env.get("TEMP") ??
      Deno.env.get("TMP");
    if (windowsCacheRoot) {
      return join(windowsCacheRoot, "typed-ski", "toolchains", "deno");
    }
  }
  const unixCacheRoot = Deno.env.get("TMPDIR") ?? "/tmp";
  return join(unixCacheRoot, "typed-ski-toolchains", "deno");
})();

function readDenoJson(): DenoJson {
  return JSON.parse(Deno.readTextFileSync(DENO_JSON_PATH)) as DenoJson;
}

function requireSemver(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^\d+\.\d+\.\d+$/.test(value)) {
    throw new Error(`deno.jsonc must contain a semantic version in ${field}`);
  }
  return value;
}

function getPinnedBinaryName(): string {
  return Deno.build.os === "windows" ? "deno.exe" : "deno";
}

function getPinnedPlatformSegment(): string {
  return `${Deno.build.os}-${Deno.build.arch}`;
}

async function readInstalledDenoVersion(
  executablePath: string,
): Promise<string | null> {
  try {
    const { code, stdout } = await new Deno.Command(
      executablePath,
      {
        args: ["--version"],
        stdin: "null",
        stdout: "piped",
        stderr: "null",
      },
    ).output();
    if (code !== 0) return null;
    const text = new TextDecoder().decode(stdout);
    const match = text.match(/^deno (\d+\.\d+\.\d+)/m);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

export function getRepoVersion(): string {
  return requireSemver(readDenoJson().version, "version");
}

export function getRequiredDenoVersion(): string {
  return requireSemver(readDenoJson().toolchain?.deno, "toolchain.deno");
}

export function getPinnedDenoPath(version = getRequiredDenoVersion()): string {
  return join(
    TOOLCHAIN_ROOT,
    version,
    getPinnedPlatformSegment(),
    getPinnedBinaryName(),
  );
}

export function assertCurrentDenoVersion(): void {
  if (Deno.env.get("TYPED_SKI_SKIP_DENO_VERSION_CHECK") === "1") return;
  const requiredVersion = getRequiredDenoVersion();
  if (Deno.version.deno !== requiredVersion) {
    throw new Error(
      `This repo requires Deno ${requiredVersion}, but found ${Deno.version.deno}. ` +
        `Run 'bazelisk run //:verify_version' to bootstrap the pinned toolchain, or ` +
        `'deno upgrade ${requiredVersion}' if you want to update your system Deno too. ` +
        `Set TYPED_SKI_SKIP_DENO_VERSION_CHECK=1 only if you need to bypass the check temporarily.`,
    );
  }
}

export async function ensureRepoDeno(): Promise<string> {
  if (Deno.env.get("TYPED_SKI_SKIP_DENO_BOOTSTRAP") === "1") {
    return Deno.execPath();
  }

  const requiredVersion = getRequiredDenoVersion();
  const currentVersion = Deno.version.deno;
  if (currentVersion === requiredVersion) {
    return Deno.execPath();
  }

  const pinnedPath = getPinnedDenoPath(requiredVersion);
  const installedVersion = await readInstalledDenoVersion(pinnedPath);
  if (installedVersion === requiredVersion) {
    return pinnedPath;
  }

  await Deno.mkdir(dirname(pinnedPath), { recursive: true });
  await Deno.remove(pinnedPath).catch(() => {});

  const { code } = await new Deno.Command(
    Deno.execPath(),
    {
      args: ["upgrade", "--output", pinnedPath, requiredVersion],
      cwd: PROJECT_ROOT,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
      env: Deno.env.toObject(),
    },
  ).output();

  if (code !== 0) {
    throw new Error(
      `Failed to install repo-pinned Deno ${requiredVersion} into ${pinnedPath}.`,
    );
  }

  const verifiedVersion = await readInstalledDenoVersion(pinnedPath);
  if (verifiedVersion !== requiredVersion) {
    throw new Error(
      `Expected repo-pinned Deno ${requiredVersion} at ${pinnedPath}, but found ${
        verifiedVersion ?? "an unreadable binary"
      }.`,
    );
  }

  return pinnedPath;
}

export async function execWithRepoDeno(args: string[]): Promise<never> {
  const denoPath = await ensureRepoDeno();
  const { code } = await new Deno.Command(
    denoPath,
    {
      args,
      cwd: PROJECT_ROOT,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
      env: Deno.env.toObject(),
    },
  ).output();
  Deno.exit(code);
}
