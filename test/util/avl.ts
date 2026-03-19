import type { TripCObject } from "../../lib/compiler/objectFile.ts";
import { loadTripModuleObject } from "../../lib/tripSourceLoader.ts";

const AVL_SOURCE_FILE = new URL("../../lib/avl.trip", import.meta.url);

/**
 * Loads the AVL tree module for testing.
 */
export async function getAvlObject(): Promise<TripCObject> {
  return await loadTripModuleObject(AVL_SOURCE_FILE);
}
