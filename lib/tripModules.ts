/**
 * Built-in Trip module source registry.
 *
 * Single source of truth for the name -> .trip source mapping used by tests
 * and compiler bootstrap helpers. Internal to the lib tree.
 */
import { join } from "node:path";
import { workspaceRoot } from "./shared/workspaceRoot.ts";

export type PublicTripModuleName = "Prelude" | "Nat" | "Bin" | "Avl";

const MODULE_PATHS: Record<PublicTripModuleName, readonly string[]> = {
  Prelude: ["lib", "prelude.trip"],
  Nat: ["lib", "nat.trip"],
  Bin: ["lib", "bin.trip"],
  Avl: ["lib", "avl.trip"],
};

export function tripModuleSourcePath(name: PublicTripModuleName): string {
  return join(workspaceRoot, ...MODULE_PATHS[name]);
}
