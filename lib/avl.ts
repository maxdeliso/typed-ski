/**
 * Avl module provider.
 */
import type { TripCObject } from "./compiler/objectFile.ts";
import { getTripModuleObject } from "./tripModules.ts";

export function getAvlObject(): Promise<TripCObject> {
  return getTripModuleObject("Avl");
}
