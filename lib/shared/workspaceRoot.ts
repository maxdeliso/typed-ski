import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __file = dirname(fileURLToPath(import.meta.url));

/**
 * Absolute path to the repository root (the directory containing package.json).
 *
 * Resolution order:
 *   1. TYPED_SKI_PROJECT_ROOT env var — set by scripts/bazel.ts before
 *      spawning the test child process, and by Bazel test rules. This is the
 *      authoritative value; no directory-level arithmetic needed in consumers.
 *   2. __dirname-relative fallback: this file compiles to
 *      ts_out/lib/shared/workspaceRoot.js, so three parent hops reach the
 *      repo root. The fallback is correct for direct `node ts_out/...`
 *      invocations that bypass scripts/bazel.ts.
 */
export const workspaceRoot: string =
  process.env["TYPED_SKI_PROJECT_ROOT"] ?? resolve(__file, "..", "..", "..");
