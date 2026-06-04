import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { workspaceRoot } from "./workspaceRoot.ts";

/**
 * Dynamically resolves the path to the Clang executable fetched by Bazel.
 * If the environment variable TYPED_SKI_CLANG is set, that takes priority.
 * Otherwise, queries Bazel for the output base, searches the external directory
 * for the platform-appropriate LLVM/Clang archive, and returns the path to the
 * executable if found.
 */
export function findLocalClangPath(): string | null {
  if (process.env["TYPED_SKI_CLANG"]) {
    return process.env["TYPED_SKI_CLANG"];
  }

  let outputBase = "";
  const suffix = process.platform === "win32" ? ".exe" : "";
  const candidates = [`bazelisk${suffix}`, `bazel${suffix}`];

  for (const bin of candidates) {
    try {
      outputBase = execSync(`${bin} info output_base`, {
        cwd: workspaceRoot,
        stdio: ["ignore", "pipe", "ignore"],
        encoding: "utf8",
        timeout: 5000,
      }).trim();
      if (outputBase) {
        break;
      }
    } catch {
      // Try next binary candidate
    }
  }

  if (!outputBase) {
    console.warn(
      "findLocalClangPath: failed to run bazelisk/bazel info output_base",
    );
    return null;
  }

  const externalDir = path.join(outputBase, "external");
  if (!fs.existsSync(externalDir)) {
    return null;
  }

  let targetPattern = "";
  let binaryName = "";
  if (process.platform === "win32") {
    targetPattern = "typed_ski_llvm_windows_x64";
    binaryName = "clang.exe";
  } else if (process.platform === "darwin") {
    targetPattern = "typed_ski_llvm_macos_arm64";
    binaryName = "clang";
  } else {
    targetPattern = "typed_ski_llvm_linux_x64";
    binaryName = "clang";
  }

  try {
    const entries = fs.readdirSync(externalDir);
    for (const entry of entries) {
      if (entry.includes(targetPattern)) {
        const candidateDir = path.join(externalDir, entry);
        const clangPath = path.join(candidateDir, "bin", binaryName);
        if (fs.existsSync(clangPath)) {
          return clangPath;
        }
      }
    }
  } catch (e) {
    console.warn("findLocalClangPath: error reading external dir", e);
  }

  return null;
}
