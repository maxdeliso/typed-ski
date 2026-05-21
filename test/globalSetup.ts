import { workspaceRoot } from "../lib/shared/workspaceRoot.ts";
import { spawnSync } from "node:child_process";

export async function globalSetup(): Promise<void> {
  if (!process.env["TYPED_SKI_PROJECT_ROOT"]) {
    process.env["TYPED_SKI_PROJECT_ROOT"] = workspaceRoot;
  }

  if (!process.env["TYPED_SKI_CLANG"]) {
    const whichClang = spawnSync("which", ["clang"], { encoding: "utf8" });
    if (whichClang.status === 0) {
      process.env["TYPED_SKI_CLANG"] = whichClang.stdout.trim();
    }
  }
}

export async function globalTeardown(): Promise<void> {
  return;
}
