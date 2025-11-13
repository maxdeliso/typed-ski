/**
 * String map implementation using JavaScript Map.
 *
 * This module provides a string-to-string map implementation using
 * JavaScript Map for efficient lookups.
 *
 * @module
 */

/** Create an empty string->string Map. */
export function createStringMap(): Map<string, string> {
  return new Map<string, string>();
}

/** Immutable insert into string->string map. */
export function insertStringMap(
  map: Map<string, string>,
  key: string,
  value: string,
): Map<string, string> {
  const newMap = new Map(map);
  newMap.set(key, value);
  return newMap;
}

/** Immutable search for string->string map. */
export function searchStringMap(
  map: Map<string, string>,
  key: string,
): string | undefined {
  return map.get(key);
}
