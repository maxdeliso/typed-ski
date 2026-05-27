/**
 * Prelude module provider.
 */
import type { TripCObject } from "./compiler/objectFile.ts";
import { getTripModuleObject } from "./tripModules.ts";

export function getPreludeObject(): Promise<TripCObject> {
  return getTripModuleObject("Prelude");
}
