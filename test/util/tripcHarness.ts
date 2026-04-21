import {
  spawnSync,
  type SpawnSyncOptions,
  type SpawnSyncReturns,
} from "node:child_process";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_TEMP_ROOT = process.env["TEST_TMPDIR"] ?? tmpdir();

export const projectRoot = resolve(__dirname, "../..");
export const tripcScriptPath = join(projectRoot, "bin", "tripc.ts");

export async function createTempWorkspace(prefix: string): Promise<string> {
  return await mkdtemp(join(TEST_TEMP_ROOT, prefix));
}

export async function cleanupTempWorkspace(
  workspacePath: string | null | undefined,
): Promise<void> {
  if (!workspacePath) {
    return;
  }
  await rm(workspacePath, { recursive: true, force: true }).catch(() => {});
}

export async function copyFixtures(
  sourceDir: string,
  destinationDir: string,
  fileNames: readonly string[],
): Promise<void> {
  await Promise.all(
    fileNames.map(async (fileName) => {
      await copyFile(join(sourceDir, fileName), join(destinationDir, fileName));
    }),
  );
}

export function runTripcSync(
  args: string[],
  options: SpawnSyncOptions = {},
): SpawnSyncReturns<string> {
  return spawnSync(
    process.execPath,
    [
      "--disable-warning=ExperimentalWarning",
      "--experimental-transform-types",
      tripcScriptPath,
      ...args,
    ],
    {
      ...options,
      encoding: "utf8",
    },
  );
}

export function resolveDistPath(
  envName: string,
  fallbackRelativePath: string,
): string {
  return process.env[envName] ?? join(projectRoot, fallbackRelativePath);
}
