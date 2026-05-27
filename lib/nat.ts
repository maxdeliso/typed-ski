/**
 * Nat module provider.
 */
import type { TripCObject } from "./compiler/objectFile.ts";
import { getTripModuleObject } from "./tripModules.ts";

export function getNatObject(): Promise<TripCObject> {
  return getTripModuleObject("Nat");
}
