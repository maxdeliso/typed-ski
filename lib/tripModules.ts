/**
 * Built-in Trip module registry.
 *
 * Single source of truth for the name -> .trip source mapping used by the
 * four public `getXObject` providers. Internal to the lib tree; the public
 * surface continues to expose the named providers re-exported by
 * `lib/index.ts`.
 */
import { join } from "node:path";
import type { TripCObject } from "./compiler/objectFile.ts";
import { loadTripModuleObject } from "./tripSourceLoader.ts";
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

export function getTripModuleObject(
  name: PublicTripModuleName,
): Promise<TripCObject> {
  return loadTripModuleObject(tripModuleSourcePath(name));
}
