/**
 * Avl module provider.
 */
import { join } from "node:path";
import type { TripCObject } from "./compiler/objectFile.ts";
import { loadTripModuleObject } from "./tripSourceLoader.ts";
import { workspaceRoot } from "./shared/workspaceRoot.ts";

export async function getAvlObject(): Promise<TripCObject> {
  return await loadTripModuleObject(join(workspaceRoot, "lib", "avl.trip"));
}
