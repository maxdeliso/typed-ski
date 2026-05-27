/**
 * Bin module provider.
 */
import type { TripCObject } from "./compiler/objectFile.ts";
import { getTripModuleObject } from "./tripModules.ts";

export function getBinObject(): Promise<TripCObject> {
  return getTripModuleObject("Bin");
}
