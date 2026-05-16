import { join } from "node:path";
import { workspaceRoot } from "../../lib/shared/workspaceRoot.ts";
import type { TripCObject } from "../../lib/compiler/objectFile.ts";
import { loadTripModuleObject } from "../../lib/tripSourceLoader.ts";

const AVL_SOURCE_FILE = join(workspaceRoot, "lib", "avl.trip");

/**
 * Loads the AVL tree module for testing.
 */
export async function getAvlObject(): Promise<TripCObject> {
  return await loadTripModuleObject(AVL_SOURCE_FILE);
}
