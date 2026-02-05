/**
 * Nat module provider.
 */
import type { TripCObject } from "./compiler/objectFile.ts";
import { loadTripModuleObject } from "./tripSourceLoader.ts";

const NAT_SOURCE_FILE = new URL("./nat.trip", import.meta.url);

export async function getNatObject(): Promise<TripCObject> {
  return await loadTripModuleObject(NAT_SOURCE_FILE);
}
