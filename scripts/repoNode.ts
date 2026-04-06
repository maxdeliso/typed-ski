import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

type PackageJson = {
  version: string;
  engines?: {
    node?: string;
  };
};

const __dirname = dirname(fileURLToPath(import.meta.url));

export const PROJECT_ROOT = join(__dirname, "..");
console.log(`[repoNode] PROJECT_ROOT: ${PROJECT_ROOT}`);
const PACKAGE_JSON_PATH = join(PROJECT_ROOT, "package.json");

function readPackageJson(): PackageJson {
  return JSON.parse(readFileSync(PACKAGE_JSON_PATH, "utf8")) as PackageJson;
}

export function getRepoVersion(): string {
  return readPackageJson().version;
}

export function getRequiredNodeVersion(): string {
  return readPackageJson().engines?.node ?? "25.x";
}

function getRequiredNodeMajor(): number | null {
  const required = getRequiredNodeVersion();
  const major = required.match(/(\d+)/)?.[1];
  return major === undefined ? null : Number(major);
}

export function assertCurrentNodeVersion(): void {
  if (process.env["TYPED_SKI_SKIP_NODE_VERSION_CHECK"] === "1") {
    return;
  }

  const current = process.version.replace("v", "");
  const required = getRequiredNodeVersion();
  const requiredMajor = getRequiredNodeMajor();
  const currentMajor = Number(current.split(".")[0]);

  if (requiredMajor !== null && currentMajor !== requiredMajor) {
    console.warn(
      `Warning: This repo expects Node ${required}, but found ${current}.`,
    );
  }
}

export async function ensureRepoNode(): Promise<string> {
  // For Node, we'll rely on the user having the right version for now,
  // or use the one managed by Bazel if we're running under Bazel.
  return process.execPath;
}

export function execWithRepoNode(args: string[]): never {
  const nodePath = process.execPath;
  const result = spawnSync(nodePath, args, {
    cwd: PROJECT_ROOT,
    stdio: "inherit",
    env: process.env,
  });
  process.exit(result.status ?? 0);
}
