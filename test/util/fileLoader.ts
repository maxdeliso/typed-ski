import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { workspaceRoot } from "../../lib/shared/workspaceRoot.ts";
import { loadTripSourceFileSync } from "../../lib/tripSourceLoader.ts";

export function loadInput(filename: string, dirname: string): string {
  const filePath = resolve(dirname, "inputs", filename);
  return loadTripSourceFileSync(filePath).trim();
}

/**
 * Reads a text file at a path relative to the workspace root.
 *
 * Use this instead of `readFileSync(relativePath, ...)` for any fixture or
 * sample that ships with the repo. Unlike a bare relative-path `readFileSync`:
 *
 *   - It is independent of `process.cwd()` — the path is anchored to
 *     `workspaceRoot` (driven by the `TYPED_SKI_PROJECT_ROOT` env var, or
 *     a `__dirname` fallback). Tests don't care what directory they were
 *     launched from.
 *
 *   - A missing file produces a diagnostic naming the absolute path tried,
 *     where the workspace root came from, and the most likely causes (file
 *     missing from Bazel test data, missing from `ts_compile` srcs, or a
 *     typo). The bare-readFileSync ENOENT is silent about all of this.
 */
export function loadWorkspaceFile(workspaceRelativePath: string): string {
  if (isAbsolute(workspaceRelativePath)) {
    throw new Error(
      `loadWorkspaceFile expects a path relative to the workspace root, ` +
        `but got an absolute path: ${workspaceRelativePath}`,
    );
  }

  const absolutePath = join(workspaceRoot, workspaceRelativePath);

  try {
    return readFileSync(absolutePath, "utf8");
  } catch (cause) {
    if (existsSync(absolutePath)) {
      // Genuine read failure (permissions, encoding, etc.) — propagate as-is.
      throw cause;
    }
    const rootSource = process.env["TYPED_SKI_PROJECT_ROOT"]
      ? "TYPED_SKI_PROJECT_ROOT env"
      : "__dirname fallback in lib/shared/workspaceRoot.ts";
    throw new Error(
      [
        `Test fixture not found.`,
        `  Requested:      ${workspaceRelativePath} (relative to workspace root)`,
        `  Looked at:      ${absolutePath}`,
        `  Workspace root: ${workspaceRoot} (resolved via ${rootSource})`,
        `  Process CWD:    ${process.cwd()}`,
        ``,
        `Likely causes:`,
        `  - The file is missing from the test target's data attribute.`,
        `  - If the path lives under ts_out/, the file is missing from`,
        `    the //:ts_out ts_compile srcs glob (or shadowed by a`,
        `    subpackage BUILD.bazel that the glob cannot cross).`,
        `  - The path is mistyped.`,
      ].join("\n"),
      { cause },
    );
  }
}
