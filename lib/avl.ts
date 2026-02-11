/**
 * Avl module provider.
 */
import type { TripCObject } from "./compiler/objectFile.ts";
import { loadTripModuleObject } from "./tripSourceLoader.ts";

const AVL_SOURCE_FILE = new URL("./avl.trip", import.meta.url);

export async function getAvlObject(): Promise<TripCObject> {
  return await loadTripModuleObject(AVL_SOURCE_FILE);
}
