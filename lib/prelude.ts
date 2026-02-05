/**
 * Prelude module provider.
 */
import type { TripCObject } from "./compiler/objectFile.ts";
import { loadTripModuleObject } from "./tripSourceLoader.ts";

const PRELUDE_SOURCE_FILE = new URL("./prelude.trip", import.meta.url);

export async function getPreludeObject(): Promise<TripCObject> {
  return await loadTripModuleObject(PRELUDE_SOURCE_FILE);
}
