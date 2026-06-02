import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_TEMP_ROOT = process.env["TEST_TMPDIR"] ?? tmpdir();

export const jsRoot = resolve(__dirname, "../..");
export const projectRoot = resolve(__dirname, "../../..");
export const srcRoot = projectRoot;
export const tripcScriptPath = join(jsRoot, "bin", "tripc.js");

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

export function resolveDistPath(
  envName: string,
  fallbackRelativePath: string,
): string {
  return process.env[envName] ?? join(srcRoot, fallbackRelativePath);
}
