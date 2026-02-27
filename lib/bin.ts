/**
 * Bin module provider.
 */
import type { TripCObject } from "./compiler/objectFile.ts";
import { loadTripModuleObject } from "./tripSourceLoader.ts";

const BIN_SOURCE_FILE = new URL("./bin.trip", import.meta.url);

export async function getBinObject(): Promise<TripCObject> {
  return await loadTripModuleObject(BIN_SOURCE_FILE);
}
