import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __file = dirname(fileURLToPath(import.meta.url));

/**
 * Absolute path to the repository root (the directory containing package.json).
 *
 * Resolution order:
 *   1. TYPED_SKI_PROJECT_ROOT env var — set by scripts/bazel.ts before
 *      spawning the test child process, and by Bazel test rules. This is the
 *      authoritative value; no directory-level arithmetic needed in consumers.
 *   2. Nearest ancestor directory that contains a package.json. This is
 *      location-independent, so it resolves correctly whether this module runs
 *      from source (lib/shared/workspaceRoot.ts, e.g. under `bun test`) or from
 *      compiled output (ts_out/lib/shared/workspaceRoot.js, under
 *      `node ts_out/...`). The previous fixed three-hop fallback assumed the
 *      compiled depth and pointed one level above the repo when run from source.
 *   3. __dirname-relative fallback (compiled layout: three parent hops) for the
 *      degenerate case where no package.json is found while walking up.
 */
function findPackageRoot(start: string): string | undefined {
  let dir = start;
  for (;;) {
    if (existsSync(join(dir, "package.json"))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return undefined;
    }
    dir = parent;
  }
}

export const workspaceRoot: string =
  process.env["TYPED_SKI_PROJECT_ROOT"] ??
  findPackageRoot(__file) ??
  resolve(__file, "..", "..", "..");
