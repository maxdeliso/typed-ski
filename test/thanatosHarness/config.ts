import { existsSync } from "std/fs";
import { dirname, fromFileUrl, join } from "std/path";

const __dirname = dirname(fromFileUrl(import.meta.url));
const TEST_NATIVE_WORKERS = 2;
const THANATOS_FILE_NAME = Deno.build.os === "windows"
  ? "thanatos.exe"
  : "thanatos";

export const PROJECT_ROOT = join(__dirname, "..", "..");

const DEFAULT_THANATOS_BIN_CANDIDATES = [
  join(PROJECT_ROOT, "bazel-bin", "core", THANATOS_FILE_NAME),
  join(PROJECT_ROOT, "bin", THANATOS_FILE_NAME),
];
const DEFAULT_THANATOS_BIN =
  DEFAULT_THANATOS_BIN_CANDIDATES.find((path) => existsSync(path)) ??
    DEFAULT_THANATOS_BIN_CANDIDATES[0]!;

export const THANATOS_BIN =
  typeof Deno !== "undefined" && Deno.env.get("THANATOS_BIN")
    ? Deno.env.get("THANATOS_BIN")!
    : DEFAULT_THANATOS_BIN;

export function thanatosAvailable(): boolean {
  return existsSync(THANATOS_BIN);
}

export function defaultWorkerCount(): number {
  const detected = typeof navigator !== "undefined" &&
      navigator.hardwareConcurrency > 0
    ? navigator.hardwareConcurrency
    : 4;
  return Math.max(TEST_NATIVE_WORKERS, Math.min(detected, 4));
}
